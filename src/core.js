const puppeteer = require("puppeteer");
const devices = require("puppeteer/DeviceDescriptors");
const fse = require("fs-extra");
const mkdirp = require("mkdirp");
const rimraf = require("rimraf");
const path = require("path");
const beautify = require("js-beautify").html;
const colors = require("colors");
const amphtmlValidator = require("amphtml-validator");
const purify = require("purify-css");
const { setValue, getValue, hasKey } = require("./cache.js");
const argv = require("minimist")(process.argv.slice(2));
const CleanCSS = require("clean-css");
const Diff = require("diff");
const assert = require("assert");
const httpServer = require("http-server");
const portfinder = require("portfinder");
const { JSDOM } = require("jsdom");
const watermarkTpl = require("./watermark");
// const kill = require("kill-port");

const getDurationInMilliseconds = (start) => {
  const NS_PER_SEC = 1e9;
  const NS_TO_MS = 1e6;
  const diff = process.hrtime(start);

  return (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;
};

let verbose;
const serverPortMap = {};

async function amplifyFunc(browser, url, steps, argv, computedDimensions) {
  let sourceDom = null;
  let styleByUrls = {},
    allStyles = "";

  function replaceEnvVars(str, envVars) {
    Object.keys(envVars).forEach((key) => {
      if (typeof str === "string") {
        str = str.replace(key, envVars[key]);
      }
    });
    return str;
  }

  async function collectStyles(response) {
    if (response.request().resourceType() === "stylesheet") {
      const reqUrl = new URL(response.request().url());
      if (
        !["instagram", "google", "twitter", "twttr"].includes(
          reqUrl.hostname.split(".")[1]
        )
      ) {
        let url = await response.url();
        let text = await response.text();
        allStyles += text;
        styleByUrls[url] = text;
      }
    }
  }

  async function validateAMP(html, printResult) {
    const ampValidator = await amphtmlValidator.getInstance();
    let errors = [];

    let result = ampValidator.validateString(html);
    if (result.status === "PASS") {
      if (printResult) console.log("\tAMP validation successful.".green);
    } else {
      result.errors.forEach((e) => {
        var msg = `line ${e.line}, col ${e.col}: ${e.message}`;
        if (e.specUrl) msg += ` (see ${e.specUrl})`;
        if (verbose) console.log("\t" + msg.dim);
        errors.push(msg);
      });
      if (printResult)
        console.log(`\t${errors.length} AMP validation errors.`.red);
    }
    return Promise.resolve(errors);
  }

  function matchAmpErrors(errors, ampErrorsRegex) {
    let resultSet = new Set();
    errors.forEach((error) => {
      let matches = error.match(new RegExp(ampErrorsRegex));
      if (matches) {
        resultSet.add(matches);
      }
    });
    return resultSet;
  }

  function beautifyHtml(sourceDom) {
    // Beautify html.
    let html = beautify(sourceDom.documentElement.outerHTML, {
      indent_size: 2,
      preserve_newlines: false,
      content_unformatted: ["script", "style"],
    });
    return "<!DOCTYPE html>\n" + html;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function writeToFile(outputPath, filename, html, options) {
    let filePath = path.resolve(`./output/${outputPath}/${filename}`);
    await fse.outputFile(filePath, html);
  }

  async function runAction(
    action,
    sourceDom,
    page,
    url,
    ampErrors,
    validate = false,
    envVars
  ) {
    if (!serverPortMap[url]) {
      return;
    }
    let elements, el, destEl, elHtml, regex, matches, newEl, body;
    let numReplaced = 0,
      oldStyles = "",
      newStyles = "",
      optimizedStyles = "";
    let message = action.actionType;
    let result = {};

    // Replace the action's all properties with envVars values.
    Object.keys(action).forEach((prop) => {
      action[prop] = replaceEnvVars(action[prop], envVars);
    });

    if (action.waitAfterLoaded) {
      await page.waitFor(action.waitAfterLoaded);
    }

    switch (action.actionType) {
      case "setAttribute":
        elements = sourceDom.querySelectorAll(action.selector);
        elements.forEach((el) => {
          el.setAttribute(action.attribute, action.value);
        });
        message = `set ${action.attribute} as ${action.value}`;
        break;

      case "removeAttribute":
        elements = sourceDom.querySelectorAll(action.selector);
        elements.forEach((el) => {
          el.removeAttribute(action.attribute);
        });
        message = `remove ${action.attribute} from ${elements.length} elements`;
        break;

      case "replaceBasedOnAmpErrors":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        let ampErrorMatches = matchAmpErrors(ampErrors, action.ampErrorRegex);
        let regexStr;
        let matchSet = new Set();

        elements.forEach((el) => {
          ampErrorMatches.forEach((matches) => {
            regexStr = action.regex;
            for (let i = 1; i <= 9; i++) {
              if (matches[i]) {
                regexStr = regexStr.replace(
                  new RegExp("\\$" + i, "g"),
                  matches[i]
                );
                matchSet.add(matches[i]);
              }
            }
            regex = new RegExp(regexStr);
            matches = el.innerHTML.match(regex);
            numReplaced += matches ? matches.length : 0;
            el.innerHTML = el.innerHTML.replace(regex, action.replace);
          });
        });
        message = `${numReplaced} replaced: ${[...matchSet].join(", ")}`;
        break;

      case "removeDisallowedAttribute": {
        let ampErrorRegex =
          "The attribute '([^']*)' may not appear in tag '([\\w-]* > )*([\\w-]*)'";
        let ampErrorMatches = matchAmpErrors(ampErrors, ampErrorRegex);
        let matchSet = new Set();
        let numRemoved = 0;

        ampErrorMatches.forEach((matches) => {
          let attribute = matches[1];
          let tag = matches[3];
          matchSet.add(attribute);
          numRemoved += matches ? matches.length : 0;

          elements = sourceDom.querySelectorAll(tag);
          elements.forEach((el) => {
            el.removeAttribute(attribute);
          });
        });

        message = `${numRemoved} removed: ${[...matchSet].join(", ")}`;
        break;
      }

      case "replace":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        const searchingScript = action.tag === "script";
        elements.forEach((el) => {
          if (
            searchingScript &&
            el.parentNode &&
            el.parentNode.tagName &&
            el.parentNode.tagName.startsWith("AMP")
          ) {
          } else {
            elHtml = el.innerHTML;
            regex = new RegExp(action.regex, "ig");
            matches = elHtml.match(regex, "ig");
            numReplaced += matches ? matches.length : 0;
            elHtml = elHtml.replace(regex, action.replace);
            el.innerHTML = elHtml;
          }
        });
        message = `${numReplaced} replaced`;
        break;

      case "replaceOrInsert":
        el = sourceDom.querySelector(action.selector);
        if (!el) throw new Error(`No matched element(s): ${action.selector}`);
        elHtml = el.innerHTML;
        regex = new RegExp(action.regex, "ig");
        if (elHtml.match(regex, "ig")) {
          if (action.log === "Add canonical link.") {
            if (!sourceDom.querySelector('link[rel="canonical"]')) {
              elHtml = elHtml + ` <link rel="canonical" href="${url}">`;
            }
          } else {
            elHtml = elHtml.replace(regex, action.replace);
          }
          el.innerHTML = elHtml;
          message = "Replaced";
        } else {
          newEl = sourceDom.createElement("template");
          if (action.log === "Add canonical link.") {
            if (!sourceDom.querySelector('link[rel="canonical"]')) {
              newEl.innerHTML =
                newEl.innerHTML + ` <link rel="canonical" href="${url}">`;
              el.innerHTML = el.innerHTML + newEl.innerHTML;
            }
          } else {
            newEl.innerHTML = action.replace;
            newEl.content.childNodes.forEach((node) => {
              el.appendChild(node);
            });
          }

          message = `Inserted in ${action.selector}`;
        }
        break;

      case "insert":
        el = sourceDom.querySelector(action.selector);
        if (!el) throw new Error(`No matched element(s): ${action.selector}`);

        el.innerHTML += action.value || "";
        message = `Inserted in ${action.selector}`;
        break;

      case "insertAtStart":
        el = sourceDom.querySelector(action.selector);
        if (!el) throw new Error(`No matched element(s): ${action.selector}`);
        const html = el.innerHTML;
        el.innerHTML = (action.value || "") + html;
        message = `Inserted in ${action.selector}`;
        break;

      case "appendAfter":
        el = sourceDom.querySelector(action.selector);
        if (!el) throw new Error(`No matched element(s): ${action.selector}`);

        newEl = sourceDom.createElement("template");
        newEl.innerHTML = action.value;
        Array.from(newEl.content.childNodes).forEach((node) => {
          el.parentNode.insertBefore(node, el.nextSibling);
        });
        message = "Dom appended";
        break;

      case "move":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        destEl = sourceDom.querySelector(action.destSelector);
        if (!destEl)
          throw new Error(`No matched element: ${action.destSelector}`);

        var movedContent = "";
        elements.forEach((el) => {
          movedContent += el.outerHTML + "\n";
          el.parentNode.removeChild(el);
        });

        destEl.innerHTML += movedContent;
        message = `Moved ${elements.length} elements`;
        break;

      // Merge multiple DOMs into one.
      case "mergeContent":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        destEl = sourceDom.querySelector(action.destSelector);
        if (!destEl)
          throw new Error(`No matched element: ${action.destSelector}`);

        var mergedContent = "";
        var firstEl = elements[0];
        elements.forEach((el) => {
          mergedContent += el.innerHTML + "\n";
          el.parentNode.removeChild(el);
        });

        firstEl.innerHTML = mergedContent;
        destEl.innerHTML += firstEl.outerHTML;
        message = `Merged ${elements.length} elements`;
        break;

      case "inlineExternalStyles":
        el = sourceDom.querySelector(action.selector);
        if (!el) throw new Error(`No matched element(s): ${action.selector}`);

        newStyles = action.minify
          ? new CleanCSS({}).minify(allStyles).styles
          : allStyles;

        newEl = sourceDom.createElement("style");
        newEl.appendChild(sourceDom.createTextNode(newStyles));
        el.appendChild(newEl);
        message = "styles appended";
        break;

      case "removeUnusedStyles":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        body = sourceDom.querySelector("body");
        oldStyles = "";
        newStyles = "";
        optimizedStyles = "";

        elements.forEach((el) => {
          // if (el.tagName !== 'style') return;
          oldStyles += el.innerHTML;

          // Use CleanCSS to prevent breaking from bad syntax.
          newStyles = new CleanCSS({
            all: false, // Disabled minification.
            format: "beautify",
          }).minify(el.innerHTML).styles;

          // Use PurifyCSS to remove unused CSS.
          let purifyOptions = {
            minify: action.minify || false,
          };
          newStyles = purify(body.innerHTML, newStyles, purifyOptions);
          el.innerHTML = newStyles;
          optimizedStyles += "\n\n" + newStyles;
        });

        // Collect unused styles.
        if (action.outputCSS) {
          let diff = Diff.diffLines(optimizedStyles, oldStyles, {
            ignoreWhitespace: true,
          });
          let unusedStyles = "";
          diff.forEach((part) => {
            unusedStyles += part.value + "\n";
          });
          unusedStyles = new CleanCSS({
            all: false, // Disabled minification.
            format: "beautify",
          }).minify(unusedStyles).styles;

          // Return back to action result.
          result.optimizedStyles = optimizedStyles;
          result.unusedStyles = unusedStyles;
        }

        let oldSize = oldStyles.length,
          newSize = optimizedStyles.length;
        let ratio = Math.round(((oldSize - newSize) / oldSize) * 100);
        message = `Removed ${ratio}% styles. (${oldSize} -> ${newSize} bytes)`;
        break;

      case "customFunc":
        elements = sourceDom.querySelectorAll(action.selector);
        if (!elements.length)
          throw new Error(`No matched element(s): ${action.selector}`);

        if (action.customFunc) {
          await action.customFunc(
            action,
            elements,
            page,
            sourceDom.documentElement
          );
        }
        break;

      default:
        console.log(`${action.actionType} is not supported.`.red);
        break;
    }
    console.log(
      `\t${action.log || action.actionType}:`.reset + ` ${message}`.dim
    );

    // Beautify html and update to source DOM.
    html = beautifyHtml(sourceDom);
    sourceDom.documentElement.innerHTML = html;

    // Validate AMP.
    if (validate) {
      ampErrors = await validateAMP(html);
    }

    // Update page content with updated HTML.
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
    });

    result.html = html;
    return result;
  }

  //add disclaimer watermark
  //TODO: refactor disclaimer text to a static file
  function addDisclaminerWatermark(html) {
    console.log("Adding disclaimer".yellow);
    let bodyTag = html.match(/<body[^>]*>/);
    return bodyTag ? html.replace(bodyTag, bodyTag + watermarkTpl) : html;
  }

  if (
    process.env.NODE_ENV === "staging" ||
    process.env.NODE_ENV === "production"
  ) {
    await delay(5000 + Object.keys(serverPortMap).length * 2000);
  }

  let port = await portfinder
    .getPortPromise({
      port: 5001, // minimum port
      stopPort: 6000, // maximum port
    })
    .catch((err) => {
      Promise.resolve(6001);
    });

  console.log("PORT ", port);

  let ampErrors = [];
  let outputName = new URL(url).pathname.split("/").slice(-1)[0];
  // Set output subfolder using domain if undefined.
  let outputPath = argv["output"] || outputName;

  let server = httpServer.createServer({ root: `output/${outputPath}/` });
  server.listen(port, "127.0.0.1", () => {
    console.log("Local server started!".cyan);
  });

  serverPortMap[url] = server;

  const start = process.hrtime();
  argv = argv || {};
  verbose = argv.hasOwnProperty("verbose");

  let device = argv["device"] || "Pixel 2";
  let consoleOutputs = [];

  // Print warnings when missing necessary arguments.
  assert(url, "Missing url.");
  assert(steps, "Missing steps");

  // Set default protocol as https if no protocol is given.
  let protocol = url.match(/(https|http).*/i);
  url = protocol ? url : "https://" + url;

  let host = url.match(/(https|http)\:\/\/([\w.-]*(\:\d+)?)/i)[0];
  assert(host, "Unable to get host from " + url);

  let domain = host.replace(/http(s)?:\/\//gi, "");
  let urlWithoutProtocol = url.replace(/http(s)?:\/\//gi, "");

  assert(domain, "Unable to get domain from " + url);

  const urlWithoutQuery = new URL(url);
  let envVars = {
    $URL: encodeURI(urlWithoutQuery.origin + urlWithoutQuery.pathname),
    $HOST: host,
    $DOMAIN: domain,
  };

  console.log("Url: " + url.green);
  console.log("Host: " + host.green);
  console.log("Domain: " + domain.green);

  // Create directory if it doesn't exist.
  mkdirp(`./output/${outputPath}/`, (err) => {
    if (err) throw new Error(`Unable to create directory ${err}`);
  });
  rimraf(`./output/${outputPath}/*`, () => {
    console.log(`Removed previous output in ./output/${outputPath}`.dim);
  });

  const page = await browser.newPage();
  await page.emulate(devices[device]);
  allStyles = "";
  page.on("response", collectStyles);
  page.on("console", (consoleObj) => {
    consoleOutputs.push(consoleObj.text());
  });
  page.on("domcontentloaded", function (response) {
    // saranyuiframevideo
  });

  console.log(`Step 0: loading page: ${url}`.yellow);

  // Open URL and save source to sourceDom.
  let response = await page.goto(url, {
    waitUntil: "networkidle0",
    timeout: 0,
  });

  let pageSource = await response.text();
  let pageContent = await page.content();
  computedDimensions.computedHeight = await page.$eval("body", (ele) => {
    let compStyles = window.getComputedStyle(ele);
    return compStyles.getPropertyValue("height");
  });
  computedDimensions.computedWidth = await page.$eval("body", (ele) => {
    let compStyles = window.getComputedStyle(ele);
    return compStyles.getPropertyValue("width");
  });
  sourceDom = new JSDOM(pageContent, {
    url: host,
  }).window.document;

  console.log(
    `Step 0: ${getDurationInMilliseconds(start).toLocaleString()} ms`.green
  );
  //await validateAMP(pageContent);

  // Output initial HTML, screenshot and amp errors.
  await writeToFile(outputPath, `output-original.html`, pageContent);
  // await page.screenshot({
  //   path: `output/${outputPath}/output-original.png`,
  //   fullPage: argv["fullPageScreenshot"]
  // });
  // await writeToFile(outputPath,`output-original-validation.txt`, ampErrors.join("\n"));

  // Clear page.on listener.
  page.removeListener("response", collectStyles);

  let i = 1;
  let stepOutput = "";
  let html = beautifyHtml(sourceDom);
  let actionResult, optimizedStyles, unusedStyles, oldStyles;

  // Since puppeteer thinks were still on a public facing server
  // setting it to localhost will allow us to continue seeing
  // a page even with some errors!

  response = await page.goto(`http://127.0.0.1:${port}`);

  if (!response.ok()) {
    console.warn("Could not connect to local server with Puppeteer!");
  }

  for (let i = 0; i < steps.length; i++) {
    consoleOutputs = [];
    let step = steps[i];

    if (!step.actions || step.skip) continue;
    console.log(`Step ${i + 1}: ${step.name}`.yellow);

    for (let j = 0; j < step.actions.length; j++) {
      let action = step.actions[j];

      try {
        // The sourceDom will be updated after each action.
        actionResult = await runAction(
          action,
          sourceDom,
          page,
          url,
          ampErrors,
          false,
          envVars
        );
        html = actionResult.html;
        optimizedStyles = actionResult.optimizedStyles;
        unusedStyles = actionResult.unusedStyles;
      } catch (e) {
        if (verbose) {
          console.log(e);
        } else {
          console.log(
            `\t${action.log || action.type}:`.reset + ` Error: ${e.message}`.red
          );
        }
      }
    }
    if (!serverPortMap[url]) {
      return "";
    }

    // Write HTML to file.
    // await writeToFile(outputPath, `steps/output-step-${i + 1}.html`, html);

    /*  if (optimizedStyles) {
      await writeToFile(
        `steps/output-step-${i + 1}-optimized-css.css`,
        optimizedStyles
      );
    }
    if (unusedStyles) {
      await writeToFile(
        `steps/output-step-${i + 1}-unused-css.css`,
        unusedStyles
      );
    } */

    // Update page content with updated HTML.
    await page.setContent(html, {
      waitUntil: "networkidle0",
    });

    // Print AMP validation result.
    if (i > 7) {
      ampErrors = await validateAMP(html, true /* printResult */);
    }
    const durationInMilliseconds = getDurationInMilliseconds(start);
    console.log(
      `Step ${i + 1}: ${durationInMilliseconds.toLocaleString()} ms`.green
    );
  }

  // Add the disclaimer watermark
  // html = addDisclaminerWatermark(html);

  // need to make sure we close out the server that was used!
  await closeServer(url);

  console.log("Local server closed!".cyan);

  // Write final outcome to file.
  await writeToFile(outputPath, `output-final.html`, html);
  await page.screenshot({
    path: `output/${outputPath}/output-final.png`,
    fullPage: argv["fullPageScreenshot"],
  });
  await writeToFile(
    outputPath,
    `output-final-validation.txt`,
    (ampErrors || []).join("\n")
  );

  console.log(`You can find the output files at ./output/${outputPath}/`.cyan);
  return html;
}

async function closeServer(url) {
  if (serverPortMap[url]) {
    try {
      // if(serverPortMap[url].address()) {
      //   kill(serverPortMap[url].address().port, "tcp");
      // }
      await serverPortMap[url].close();
      delete serverPortMap[url];
    } catch (e) {
      console.error(e);
    }
  }
}

async function amplify(url, steps, argv) {
  let isHeadless = argv["headless"] ? argv["headless"] === "true" : true;

  // Start puppeteer.
  let browser = getValue("browser");

  if (!browser) {
    console.log("test");
    browser = await puppeteer.launch({
      headless: isHeadless,
    });
    setValue("browser", browser);
  }
  let result = "";
  let computedDimensions = {};

  try {
    result = await amplifyFunc(browser, url, steps, argv, computedDimensions);
    console.log("Complete.".green);
  } catch (e) {
    console.error(e);
    console.log("Complete with errors.".yellow);
  } finally {
    //  if (browser) await browser.close();
    return result;
  }
}

module.exports = {
  amplify: amplify,
  closeServer: closeServer,
};
