#!/usr/bin/env node

/**
 * Firecrawl Site-Wide Unified Markdown Generator
 * 
 * Features:
 * - Automatically discovers internal routes on any target website.
 * - Scrapes each page via Firecrawl (using clean content mode).
 * - Strips all images, base64 data, and image tags.
 * - Formats every page under a primary Heading 1 (# Page Name).
 * - Formats all functionalities and sections under structured Subheadings (##, ###).
 * - Compiles everything into a single, beautifully structured Markdown file.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to log with timestamps
function log(msg) {
  const time = new Date().toISOString().substring(11, 19);
  console.log(`[${time}] ${msg}`);
}

// Clean markdown text: strip images, badges, and normalize headings
function cleanAndFormatMarkdown(rawText, pageTitle, pageUrl) {
  let text = rawText;

  // 1. Remove Scrape ID header from firecrawl-cli if present
  text = text.replace(/^Scrape ID:[^\n]*\n+/i, '');

  // 2. Strip all markdown images: ![alt text](url) or ![alt text](<url>)
  text = text.replace(/!\[[^\]]*\]\([^\)]*\)/g, '');
  // Strip HTML image tags
  text = text.replace(/<img[^>]*>/gi, '');
  // Strip base64 image placeholders
  text = text.replace(/\[!\[[^\]]*\]\(<Base64-Image-Removed>\)\]\([^\)]*\)/g, '');
  text = text.replace(/\(!\[[^\]]*\]\(<Base64-Image-Removed>\)\)/g, '');

  // 3. Remove standalone image captions or orphaned image URLs
  text = text.replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '');

  // 4. Adjust headings: Demote existing H1s to H2s so each page has only ONE H1 (# Page Title)
  const lines = text.split('\n');
  const processedLines = [];

  for (let line of lines) {
    // If it's an H1 (# Title), change it to H2 (## Title)
    if (/^#\s+/.test(line)) {
      processedLines.push('#' + line);
    } else {
      processedLines.push(line);
    }
  }

  let cleanedBody = processedLines.join('\n');

  // 5. Clean up multiple consecutive empty lines
  cleanedBody = cleanedBody.replace(/\n{3,}/g, '\n\n').trim();

  // 6. Build the formatted page section
  const anchorId = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  return {
    title: pageTitle,
    url: pageUrl,
    anchorId,
    content: `<a id="${anchorId}"></a>\n\n# ${pageTitle}\n**Page URL:** [${pageUrl}](${pageUrl})\n\n${cleanedBody}`
  };
}

// Discover internal links from base URL
async function discoverPages(baseUrl) {
  const targetUrl = new URL(baseUrl);
  const origin = targetUrl.origin;
  const discovered = new Map(); // url -> title

  log(`Connecting to ${origin} to discover pages...`);
  
  // Always include homepage
  discovered.set(origin + '/', 'Home Page / Overview');

  try {
    const res = await fetch(origin, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (res.ok) {
      const html = await res.text();

      // Extract all hrefs
      const hrefRegex = /href=["']([^"'#\s>]+)["']/gi;
      let match;
      while ((match = hrefRegex.exec(html)) !== null) {
        let href = match[1];
        
        // Ignore assets, files, tel, mailto, etc.
        if (/^\/assets\//i.test(href)) continue;
        if (/\.(png|jpg|jpeg|jfif|avif|webp|gif|svg|css|js|woff|woff2|ttf|eot|ico|pdf|zip|tar|gz|mp4|webm|mp3)$/i.test(href.split('?')[0])) continue;
        if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;

        try {
          const resolved = new URL(href, origin);
          if (resolved.origin === origin) {
            let pathname = resolved.pathname;
            if (pathname.length > 1 && pathname.endsWith('/')) {
              pathname = pathname.slice(0, -1);
            }
            const fullUrl = origin + pathname;

            if (!discovered.has(fullUrl) && pathname !== '') {
              // Generate friendly title from path
              const cleanPath = pathname.replace(/^\//, '');
              const parts = cleanPath.split('/').filter(Boolean);
              const title = parts.length > 0 
                ? parts[parts.length - 1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                : 'Home Page';

              discovered.set(fullUrl, title);
            }
          }
        } catch (_) {}
      }

      // Check for bundle routes in scripts if SPA
      const scriptRegex = /src=["'](\/assets\/[^"']+\.js)["']/gi;
      let scriptMatch;
      while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        try {
          const sRes = await fetch(origin + scriptMatch[1]);
          if (sRes.ok) {
            const jsCode = await sRes.text();
            const routeMatches = jsCode.matchAll(/["'](\/(product|pricing|contact|privacy|terms|about|features|collections|accessories|bespoke|heritage|album|returns-policy|terms-and-conditions|privacy-policy))["']/g);
            for (const rm of routeMatches) {
              const routeUrl = origin + rm[1];
              if (!discovered.has(routeUrl)) {
                const title = rm[1].replace(/^\//, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                discovered.set(routeUrl, title);
              }
            }
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    log(`Warning during discovery: ${err.message}`);
  }

  log(`Discovered ${discovered.size} unique page(s).`);
  return Array.from(discovered.entries()).map(([url, title]) => ({ url, title }));
}

// Main execution function
export async function scrapeSiteToSingleMarkdown(targetUrl, outputFileName = null) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname.replace(/^www\./, '');
  const finalOutputFile = outputFileName || path.join(process.cwd(), `${hostname}_unified.md`);

  console.log('='.repeat(70));
  console.log(` Firecrawl Unified Site Scraper`);
  console.log(` Target Website : ${targetUrl}`);
  console.log(` Output File    : ${finalOutputFile}`);
  console.log(` Image Filtering: ENABLED (No images will be included)`);
  console.log('='.repeat(70));

  const pages = await discoverPages(targetUrl);
  const scrapedPages = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, title } = pages[i];
    log(`[${i + 1}/${pages.length}] Scraping: ${title} (${url})...`);

    try {
      // Use firecrawl-cli to scrape content
      const cmd = `npx -y firecrawl-cli@latest scrape "${url}" --only-main-content`;
      const rawOutput = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

      const cleaned = cleanAndFormatMarkdown(rawOutput, title, url);
      scrapedPages.push(cleaned);
      log(`  -> Successfully scraped and processed ${title} (${cleaned.content.length} characters)`);
    } catch (err) {
      log(`  -> Error scraping ${url}: ${err.message}`);
    }
  }

  // Compile into a single unified Markdown document
  log('Compiling master Markdown document...');
  
  let masterDoc = `# ${hostname.toUpperCase()} - Complete Website Documentation\n\n`;
  masterDoc += `> **Source Website:** [${targetUrl}](${targetUrl})  \n`;
  masterDoc += `> **Total Pages Scraped:** ${scrapedPages.length}  \n`;
  masterDoc += `> **Generated on:** ${new Date().toUTCString()}  \n`;
  masterDoc += `> **Format:** Clean Markdown (Functionality-focused, images stripped)  \n\n`;

  masterDoc += `---\n\n`;
  masterDoc += `## Table of Contents\n\n`;
  for (const page of scrapedPages) {
    masterDoc += `- [${page.title}](#${page.anchorId})\n`;
  }
  masterDoc += `\n---\n\n`;

  // Append each page content
  for (const page of scrapedPages) {
    masterDoc += page.content + '\n\n---\n\n';
  }

  fs.writeFileSync(finalOutputFile, masterDoc, 'utf8');
  const stats = fs.statSync(finalOutputFile);
  
  console.log('='.repeat(70));
  log(`All pages successfully compiled into single Markdown file!`);
  log(`File saved at: ${finalOutputFile} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log('='.repeat(70));

  return finalOutputFile;
}

// If run from CLI directly
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const targetUrl = process.argv[2];
  const customOutput = process.argv[3];

  if (!targetUrl) {
    console.error('Usage: node site_scraper.js <website-url> [output-file.md]');
    console.error('Example: node site_scraper.js https://www.patientcareapp.com/');
    process.exit(1);
  }

  scrapeSiteToSingleMarkdown(targetUrl, customOutput).catch(err => {
    console.error('Scraping failed:', err);
    process.exit(1);
  });
}
