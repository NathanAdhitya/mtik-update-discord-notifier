import "dotenv/config";
if (!process.env.WEBHOOK_URL) {
	logger.error("WEBHOOK_URL environment variable not set.");
	process.exit(1);
}

import axios from "axios";
import axiosRetry from "axios-retry";
import { XMLParser } from "fast-xml-parser";
import { MessageBuilder, Webhook } from "webhook-discord";
import { stripHtml } from "string-strip-html";
import dns from "dns/promises";
import net from "net";

import { join, dirname } from "path";
import { Low, JSONFile } from "lowdb";
import URL, { fileURLToPath } from "url";

axiosRetry(axios, { retryDelay: axiosRetry.exponentialDelay });
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Local data, to track last published date and last WinBox version. */
const file = join(__dirname, "data/data.json");
const adapter = new JSONFile(file);
const db = new Low(adapter);

const Hook = new Webhook(process.env.WEBHOOK_URL);
const changelogRSS = "https://mikrotik.com/download.rss";
const winboxPage = "https://mikrotik.com/download";
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

const DNSResolver = new dns.Resolver({ timeout: 5000, tries: 5 });
const mikrotikDotComDNS = {
	ip: null,
	lastSuccessful: 0,
};
async function dnsCache() {
	// Refresh every 24h. Attempt at every request.
	if (mikrotikDotComDNS.lastSuccessful <= Date.now() - 24 * 60 * 60 * 1000) {
		try {
			const res = (await DNSResolver.resolve4("mikrotik.com"))[0];
			if (typeof res === "string") {
				mikrotikDotComDNS.ip = res;
				mikrotikDotComDNS.lastSuccessful = Date.now();
			}
			logger.log("Renew DNS success", res);
		} catch (e) {
			logger.error("DNS resolve failure", e);
		}
	}

	return mikrotikDotComDNS.ip;
}

axios.interceptors.request.use(function (config) {
	var url = URL.parse(config.url);

	if (net.isIP(url.hostname)) {
		// Skip
		return config;
	} else {
		return dnsCache().then(function (response) {
			config.headers = config.headers || {};
			config.headers.Host = url.hostname; // put original hostname in Host header

			url.hostname = response;
			delete url.host; // clear hostname cache
			config.url = URL.format(url);

			return config;
		});
	}
});

const main = async () => {
	const embedsToSend = [];

	await Promise.all([
		// Process the changelog
		(async () => {
			try {
				const res = await axios.get(changelogRSS, { timeout: 10000 });
				if (res.status === 200) {
					const resp = res.data;
					const parser = new XMLParser();
					const parsedResponse = parser.parse(resp);
					const items = parsedResponse.rss.channel.item;

					let oldestDate = db.data.lastRouterOSDate;
					items.forEach((v) => {
						const { title, link, category, description, pubDate } =
							v;
						const jsDate = new Date(pubDate).getTime();

						if (jsDate <= db.data.lastRouterOSDate) return;
						if (jsDate > oldestDate) oldestDate = jsDate;

						const strippedDesc =
							stripHtml(description).result.split("\n");
						// shorten desc max 8 lines
						strippedDesc.length = Math.min(strippedDesc.length, 8);

						const embed = new MessageBuilder()
							.setName("Mikrotik Changelog Bot")
							.setTitle(
								`New RouterOS version published | ${title}`
							)
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
					logger.error(
						`Error fetching ${changelogRSS}. Received a ${res.status} status code.`
					);
				}
			} catch (e) {
				logger.error(e);
			}
		})(),
		// Process the Winbox
		(async () => {
			try {
				const res = await axios.get(winboxPage, { timeout: 10000 });
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
	for (const v of embedsToSend.reverse()) {
		// Send all the messages
		try {
			await Hook.send(v);
		} catch (e) {
			logger.error(e);
		}
	}
};
(async () => {
	try {
		await db.read();
		db.data ||= { lastWinBoxVersion: "", lastRouterOSDate: 0 };

		await main();

		// reschedule in 60 seconds
		scheduler();
	} catch (e) {
		logger.log("Error while running main function.");
		logger.error(e);
	}
})();

const scheduler = () =>
	setTimeout(async () => {
		try {
			await main();
		} catch (e) {
			logger.log("Error while running main function.");
			logger.error(e);
		}
		scheduler();
	}, 60000);

logger.log("Program initialized.");
