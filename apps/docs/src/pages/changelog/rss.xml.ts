/**
 * /changelog/rss.xml — hand-rolled RSS 2.0 feed (no feed dependency).
 */
import { getCollection } from "astro:content";
import { config } from "virtual:nimbus/config";

export const prerender = true;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const site = config.site ?? "http://localhost:4321";
  const feedUrl = new URL("/changelog/rss.xml", site).href;
  const channelLink = new URL("/changelog/", site).href;

  const entries = (await getCollection("changelog", (e) => !e.data.draft)).sort(
    (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  );

  const items = entries
    .map((entry) => {
      const url = new URL(`/changelog/${entry.id}/`, site).href;
      const { title, description, date, tags } = entry.data;
      return [
        "    <item>",
        `      <title>${escapeXml(title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <pubDate>${date.toUTCString()}</pubDate>`,
        ...(description ? [`      <description>${escapeXml(description)}</description>`] : []),
        ...tags.map((t) => `      <category>${escapeXml(t)}</category>`),
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXml(config.title)} Changelog</title>`,
    `    <link>${channelLink}</link>`,
    `    <description>${escapeXml(config.description ?? "Changelog")}</description>`,
    "    <language>en</language>",
    `    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />`,
    items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");

  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
