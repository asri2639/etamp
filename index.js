const fetch = require("node-fetch");
const express = require("express");
const bodyParser = require("body-parser");
const { amplify, closeServer } = require("./src/core.js");
const steps = require("./steps/default-steps.js");
const path = require("path");
const fse = require("fs-extra");
const rimraf = require("rimraf");
var cors = require('cors')

const AmpOptimizer = require("@ampproject/toolbox-optimizer");
const ampOptimizer = AmpOptimizer.create();

const app = express();
app.use(bodyParser.json());
app.use(cors())

app.use("/assets", express.static("assets"));

const getDurationInMilliseconds = (start) => {
  const NS_PER_SEC = 1e9;
  const NS_TO_MS = 1e6;
  const diff = process.hrtime(start);

  return (diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS;
};

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl} [STARTED]`);
  const start = process.hrtime();

  res.on("finish", () => {
    const durationInMilliseconds = getDurationInMilliseconds(start);
    console.log(
      `${req.method} ${
        req.originalUrl
      } [FINISHED] ${durationInMilliseconds.toLocaleString()} ms`
    );
  });

  res.on("close", () => {
    const durationInMilliseconds = getDurationInMilliseconds(start);
    console.log(
      `${req.method} ${
        req.originalUrl
      } [CLOSED] ${durationInMilliseconds.toLocaleString()} ms`
    );
  });

  next();
});

app.get("/hello", (req, res) => {
  res.send("ok");
});

app.post("/convert", async (req, res) => {
  // console.log(req.body)
  const url = req.body.url;
  // console.log(url)
  const oURL = new URL(url);
  const id = oURL.pathname.split("/").slice(-1)[0];
  const filePath = path.join(
    __dirname + "/output/" + id + "/output-final.html"
  );

  let html = "";

  req.connection.on("close", function () {
    // code to handle connection abort
    console.log("user cancelled");
    closeServer(oURL.origin + oURL.pathname + "?amp=1");
  });

  try {
    if (
      process.env.NODE_ENV === "development" &&
      fse.existsSync(__dirname + "/output/" + id + "/output-final.html") &&
      !req.body.amplify
    ) {
      html = fse.readFileSync(filePath, { encoding: "utf8", flag: "r" });
    } else {
      html = await amplify(oURL.origin + oURL.pathname + "?amp=1", steps, {});
    }

    if (!html || (html && html.trim().length === 0)) {
      res.status(400);
      res.end("");
    }

    ampOptimizer.transformHtml(html).then((optimizedHtml) => {
      res.setHeader("content-type", "application/json");
      res.send({
        requested_url: url,
        amp_html: optimizedHtml,
      });
    });

    // res.sendFile(filePath);
  } catch (err) {
    console.error(err);
    res.status(400).send(err);
  } finally {
    if (process.env.NODE_ENV !== "development") {
      rimraf(path.join(__dirname + "/output/" + id), function () {
        console.log("removed folder " + id);
      });
    }
  }
});

app.post("/convert-bulk", async (req, res) => {
  const urls = req.body.urls;
  const result = {};

  let htmls = {};

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const oURL = new URL(url);
    const id = oURL.pathname.split("/").slice(-1)[0];

    const filePath = path.join(
      __dirname + "/output/" + id + "/output-final.html"
    );

    try {
      if (fse.existsSync(__dirname + "/output/" + id + "/output-final.html")) {
        const out = fse.readFileSync(filePath, { encoding: "utf8", flag: "r" });
        htmls[id] = out;
      } else {
        const a = await amplify(
          oURL.origin + oURL.pathname + "?amp=1",
          steps,
          {}
        );
        htmls[id] = a;
      }
    } catch (err) {
      console.error(err);
    }
  }

  res.send(JSON.stringify(htmls));
  res.end();
});

app.get("*/:id(\\w+\\d+$)", async (req, res) => {
  const id = req.params.id;
  const filePath = path.join(
    __dirname + "/output/" + id + "/output-final.html"
  );

  // serving from output folder in the same server
  try {
    if (fse.existsSync(__dirname + "/output/" + id + "/output-final.html")) {
      res.sendFile(filePath);
    } else {
      await amplify(
        "https://react.etvbharat.com" + req.url + "?amp=1",
        steps,
        {}
      );
      res.sendFile(filePath);
    }
  } catch (err) {
    console.error(err);
    res.end("404");
  }

  /* fetch(
    `http://staging.api.etvbharat.com/amp/${id}?auth_token=xNppFXL5h4qhA7XsE4Nx`,
    { headers: { "Content-Type": "application/json" } }
  )
    .then(response => {
      return response.json();
    })
    .then(function(rest) {
      res.set("Content-Type", "text/html");
    }); */
});
app.listen(5000, "0.0.0.0", () =>
  console.log(`Started server at http://localhost:5000!`)
);
