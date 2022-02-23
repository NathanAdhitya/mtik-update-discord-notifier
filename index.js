import "dotenv/config";
if (!process.env.WEBHOOK_URL) {
	console.error("WEBHOOK_URL environment variable not set.");
	process.exit(1);
}

import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import { MessageBuilder, Webhook } from "webhook-discord";
import { stripHtml } from "string-strip-html";

import { join, dirname } from "path";
import { Low, JSONFile } from "lowdb";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Local data, to track last published date and last WinBox version. */
const file = join(__dirname, "data/data.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

await db.read();
db.data ||= { lastWinBoxVersion: "", lastRouterOSDate: 0 };

const Hook = new Webhook(process.env.WEBHOOK_URL);
const changelogRSS = "https://mikrotik.com/download.rss";
const winboxPage = "https://mikrotik.com/download";
const winboxRegex = /WinBox (\d+.\d+) \(64\-bit\)/;

const embedColors = {
	"Long-term": "#3498DB",
	Stable: "#2ECC71",
	Testing: "#E74C3C",
	Development: "#992D22",
};

const main = async () => {
	const embedsToSend = [];

	await Promise.all([
		// Process the changelog
		(async () => {
			const res = await fetch(changelogRSS);
			if (res.ok) {
				const resp = await res.text();
				const parser = new XMLParser();
				const parsedResponse = parser.parse(resp);
				const items = parsedResponse.rss.channel.item;

				let oldestDate = db.data.lastRouterOSDate;
				items.forEach((v) => {
					const { title, link, category, description, pubDate } = v;
					const jsDate = new Date(pubDate).getTime();

					if (jsDate <= db.data.lastRouterOSDate) return;
					if (jsDate > oldestDate) oldestDate = jsDate;

					const strippedDesc =
						stripHtml(description).result.split("\n");
					// shorten desc max 8 lines
					strippedDesc.length = Math.min(strippedDesc.length, 8);

					const embed = new MessageBuilder()
						.setName("Mikrotik Changelog Bot")
						.setTitle(`New RouterOS version published | ${title}`)
						.setColor(
							category in embedColors
								? embedColors[category]
								: "#23272A"
						)
						.setDescription(
							`${strippedDesc.join(
								"\n"
							)}...\n[Click here to read the full changelog](${link})`
						)
						.setTime(jsDate / 1000)
						.setURL(link);

					embedsToSend.push(embed);
				});

				db.data.lastRouterOSDate = oldestDate;
			} else {
				console.error(
					`Error fetching ${changelogRSS}. Received a ${res.status} status code.`
				);
			}
		})(),
		// Process the Winbox
		(async () => {
			const res = await fetch(winboxPage);
			if (res.ok) {
				const resp = await res.text();
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
				console.error(
					`Error fetching ${winboxPage}. Received a ${res.status} status code.`
				);
			}
		})(),
	]);

	// Write changes to database.
	await db.write();

	// uh, so everything is in order.
	for (const v of embedsToSend.reverse()) {
		// Send all the messages
		await Hook.send(v);
	}
};

await main();

const scheduler = () =>
	setTimeout(async () => {
		await main();
		scheduler();
	}, 60000);

// reschedule in 60 seconds
scheduler();
console.log("Program initialized.");
