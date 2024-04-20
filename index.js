import "dotenv/config";
if (!process.env.WEBHOOK_URL) {
  logger.error("WEBHOOK_URL environment variable not set.");
  process.exit(1);
}

const debugMode = process.argv.includes("--debug");
const runOnceMode = process.argv.includes("--once");
const REQUEST_TIMEOUT = Number.isInteger(
  Number.parseInt(process.env.REQUEST_TIMEOUT)
)
  ? Number.parseInt(process.env.REQUEST_TIMEOUT)
  : 30000;

import axios from "axios";
import axiosRetry from "axios-retry";
import { XMLParser } from "fast-xml-parser";
import { MessageBuilder, Webhook } from "webhook-discord";
import { stripHtml } from "string-strip-html";

import { join, dirname } from "path";
import { Low, JSONFile } from "lowdb";
import { fileURLToPath } from "url";

axiosRetry(axios, { retryDelay: axiosRetry.exponentialDelay });
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Local data, to track last published date and last WinBox version. */
const file = join(__dirname, "data/data.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

const Hook = new Webhook(process.env.WEBHOOK_URL);
const changelogRSSList = [
  "https://download.mikrotik.com/routeros/latest-stable-and-long-term.rss",
  "https://download.mikrotik.com/routeros/latest-development.rss",
  "https://download.mikrotik.com/routeros/latest-testing.rss",
];
const winboxPage = "https://mikrotik.com/download";
const changelogsLink = "https://mikrotik.com/download/changelogs";
const winboxRegex = /WinBox (\d+.\d+) \(64-bit\)/;

const embedColors = {
  "Long-term": "#3498DB",
  Stable: "#2ECC71",
  Testing: "#E74C3C",
  Development: "#992D22",
};

function dateLog() {
  return `[${new Date().toLocaleString()}]`;
}

const logger = {
  log: (...args) => console.log(dateLog(), ...args),
  error: (...args) => console.error(dateLog(), ...args),
};

function determineCategory(title, rssSource) {
  // Try to parse title first, if failed, then determine with rssSource
  if (title.includes("[long-term]")) return "Long-term";
  if (title.includes("[stable]")) return "Stable";
  if (title.includes("[testing]")) return "Testing";
  if (title.includes("[development]")) return "Development";

  if (rssSource === changelogRSSList[0]) return "Stable";
  if (rssSource === changelogRSSList[1]) return "Development";
  if (rssSource === changelogRSSList[2]) return "Testing";
}

const main = async () => {
  const embedsToSend = [];

  await Promise.all([
    // Process the changelog
    ...changelogRSSList.map(async (rss) => {
      try {
        const res = await axios.get(rss, { timeout: REQUEST_TIMEOUT });
        if (res.status === 200) {
          const resp = res.data;
          const parser = new XMLParser();
          const parsedResponse = parser.parse(resp);
          let items = parsedResponse.rss.channel.item;

          // If items is undefined, skip
          if (!items) return logger.error("No items found in RSS feed:", rss);

          // If items is not an array, put into an array
          if (!Array.isArray(items)) items = [items];

          const storedOldestDate = db.data.lastRSSDate[rss] || 0;
          let oldestDate = storedOldestDate;

          items.forEach((v) => {
            const { title, link, "content:encoded": content, pubDate } = v;
            const jsDate = new Date(pubDate).getTime();
            const category = determineCategory(title, rss);

            if (jsDate <= storedOldestDate) return;
            if (jsDate > oldestDate) oldestDate = jsDate;

            const strippedDesc = stripHtml(
              content.replaceAll("<br>", "\n")
            ).result.split("\n");
            // shorten desc max 8 lines
            strippedDesc.length = Math.min(strippedDesc.length, 8);

            // if more than 8 lines, add a "..." at the end
            if (strippedDesc.length === 8) strippedDesc[7] += "...";

            let effectiveDesc = strippedDesc.join("\n");
            if (effectiveDesc.length > 2048) {
              effectiveDesc = effectiveDesc.slice(0, 2045) + "...";
            }

            const embed = new MessageBuilder()
              .setName("Mikrotik Changelog Bot")
              .setTitle(`New RouterOS version published | ${title}`)
              .setColor(
                category in embedColors ? embedColors[category] : "#23272A"
              )
              .setDescription(
                `${effectiveDesc}\n[Click here to read the full changelog](${changelogsLink})`
              )
              .setTime(jsDate / 1000)
              .setURL(link);

            embedsToSend.push(embed);
          });

          db.data.lastRSSDate[rss] = oldestDate;
        } else {
          logger.error(
            `Error fetching ${rss}. Received a ${res.status} status code.`
          );
        }
      } catch (e) {
        logger.error(e);
      }
    }),
    // Process the Winbox
    (async () => {
      try {
        const res = await axios.get(winboxPage, { timeout: REQUEST_TIMEOUT });
        if (res.status === 200) {
          const resp = res.data;
          const parsedVer = winboxRegex.exec(resp)[1];

          // Skip if the version listed on the website is the same
          if (db.data.lastWinBoxVersion === parsedVer) return;
          db.data.lastWinBoxVersion = parsedVer;

          const embed = new MessageBuilder()
            .setName("Mikrotik Changelog Bot")
            .setTitle(`New WinBox version published | ${parsedVer}`)
            .setColor("#0775A1")
            .setDescription(`A new WinBox version was found.`)
            .setTime()
            .setURL(winboxPage);

          embedsToSend.push(embed);
        } else {
          logger.error(
            `Error fetching ${winboxPage}. Received a ${res.status} status code.`
          );
        }
      } catch (e) {
        logger.error(e);
      }
    })(),
  ]);

  // Write changes to database.
  await db.write();

  // uh, so everything is in order.

  // Send all the messages if not in debug mode
  if (debugMode) {
    logger.log("Debug mode enabled. Skipping sending messages.");
    return;
  }

  for (const v of embedsToSend.reverse()) {
    // Send all the messages
    try {
      await Hook.send(v);
    } catch (e) {
      logger.error(e);
    }
  }

  if (embedsToSend.length > 0)
    logger.log(`Sent ${embedsToSend.length} messages.`);
};

(async () => {
  try {
    await db.read();
    db.data ||= { lastWinBoxVersion: "", lastRSSDate: {} };
    db.data.lastRSSDate ||= {};

    await main();

    // reschedule in 60 seconds
    scheduler();
  } catch (e) {
    logger.log("Error while running main function.");
    logger.error(e);
  }
})();

const scheduler = () => {
  // Reschedule in 60 seconds if --once is not set
  if (!runOnceMode)
    setTimeout(async () => {
      try {
        await main();
      } catch (e) {
        logger.log("Error while running main function.");
        logger.error(e);
      }
      scheduler();
    }, 60000);
};

logger.log("Program initialized.");
