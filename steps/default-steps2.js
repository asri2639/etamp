module.exports = [
  {
    name: "Instagram",
    actions: [
      {
        log: "Instagram replacement",
        actionType: "customFunc",
        selector: ".twitterFeedSection",
        customFunc: async (action, elements, page) => {
          for (let i = 0; i < elements.length; i++) {
            const el = elements[i].querySelector(".instagram-media");
            const permalink = el.src;
            const match = /^(?:.*\/p\/)([\d\w\-_]+)/gi.exec(permalink);
            if (match && match.length > 1) {
              const code = match[1];
              elements[i].innerHTML = `<amp-instagram
              data-shortcode="${code}"
              data-captioned
              width="400"
              height="400"
              layout="responsive"
            >
            </amp-instagram>`;
            }
          }
        }
      }
    ]
  }
];
