import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from "playwright";
import dotenv from "dotenv";
import UserAgent from "user-agents";
import { getError } from "./helpers/get_error";

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(bodyParser.json());

const BLOCK_MEDIA =
  (process.env.BLOCK_MEDIA || "False").toUpperCase() === "TRUE";

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

const AD_SERVING_DOMAINS = [
  "doubleclick.net",
  "adservice.google.com",
  "googlesyndication.com",
  "googletagservices.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adsystem.com",
  "adservice.com",
  "adnxs.com",
  "ads-twitter.com",
  "facebook.net",
  "fbcdn.net",
  "amazon-adsystem.com",
];

interface Action {
  type:
    | "wait"
    | "click"
    | "screenshot"
    | "write"
    | "press"
    | "scroll"
    | "scrape"
    | "executeJavascript";
  milliseconds?: number;
  selector?: string;
  all?: boolean;
  fullPage?: boolean;
  quality?: number;
  viewport?: { width: number; height: number };
  text?: string;
  key?: string;
  direction?: "up" | "down";
  script?: string;
  landscape?: boolean;
  scale?: number;
  format?: string;
}

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  actions?: Action[];
}

let browser: Browser;

const initializeBrowser = async () => {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        // "--single-process",
        "--disable-gpu",
      ],
    });
  }
};

const createContext = async () => {
  const userAgent = new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = { server: PROXY_SERVER };
  }

  const context = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await context.route(
      "**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}",
      (route) => route.abort(),
    );
  }

  await context.route("**/*", (route, request) => {
    const hostname = new URL(request.url()).hostname;
    if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const executeAction = async (
  page: Page,
  action: Action,
  actionIndex: number,
  timeout: number
): Promise<any> => {
  console.log(`Executing action ${actionIndex + 1}: ${action.type}`);

  switch (action.type) {
    case "wait":
      if (
        action.milliseconds !== undefined &&
        action.milliseconds !== null
      ) {
        await page.waitForTimeout(action.milliseconds);
      } else if (action.selector) {
        await page.waitForSelector(action.selector, {
          timeout: action.milliseconds ?? timeout,
        });
      }
      return null;

    case "click":
      if (!action.selector) {
        throw new Error("Click action requires a selector");
      }
      if (action.all) {
        const elements = await page.locator(action.selector).all();
        for (const element of elements) {
          await element.click();
        }
      } else {
        await page.click(action.selector);
      }
      return null;

    case "write":
      if (!action.text) {
        throw new Error("Write action requires a text");
      }
      await page.keyboard.type(action.text);
      return null;

    case "press":
      if (!action.key) {
        throw new Error("Press action requires a key");
      }
      await page.keyboard.press(action.key);
      return null;

    case "scroll":
      if (action.selector) {
        await page.locator(action.selector).scrollIntoViewIfNeeded();
      } else {
        const direction = action.direction === "up" ? -1 : 1;
        await page.evaluate((dir) => {
          const scrollHeight = document.body.scrollHeight;
          const deltaY = dir === -1 ? -scrollHeight : scrollHeight;
          window.scrollBy(0, deltaY);
        }, direction);
      }
      return null;

    case "screenshot":
      const screenshotOptions: any = {
        fullPage: action.fullPage || false,
      };
      if (action.quality) {
        screenshotOptions.quality = action.quality;
      }
      if (action.viewport) {
        await page.setViewportSize(action.viewport);
      }
      const screenshot = await page.screenshot(screenshotOptions);
      return Buffer.from(screenshot).toString("base64");

    case "scrape":
      const html = await page.content();
      const currentUrl = page.url();
      return { url: currentUrl, html };

    case "executeJavascript":
      if (!action.script) {
        throw new Error("ExecuteJavascript action requires a script");
      }
      const jsResult = await page.evaluate(action.script);
      return { type: "executeJavascript", value: jsResult };

    default:
      console.warn(`Unknown action type: ${action.type}`);
      return null;
  }
};

const executeActions = async (
  page: Page,
  actions: Action[],
  timeout: number
): Promise<{
  screenshots: string[];
  actionContent: Array<{ url: string; html: string }>;
  actionResults: Array<{ type: string; result: any }>;
}> => {
  const screenshots: string[] = [];
  const actionContent: Array<{ url: string; html: string }> = [];
  const actionResults: Array<{ type: string; result: any }> = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    try {
      const result = await executeAction(page, action, i, timeout);

      if (result !== null) {
        if (action.type === "screenshot") {
          screenshots.push(result);
        } else if (action.type === "scrape") {
          actionContent.push(result);
        } else if (action.type === "executeJavascript") {
          actionResults.push({
            type: action.type,
            result:
              action.type === "executeJavascript"
                ? { return: JSON.stringify(result.value) }
                : { link: result },
          });
        }
      }
    } catch (error) {
      console.error(`Error executing action ${i + 1} (${action.type}):`, error);
      // Continue with next action
    }
  }

  return { screenshots, actionContent, actionResults };
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: "load" | "networkidle",
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined,
  actions: Action[] | undefined,
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`,
  );
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error("Required selector not found");
    }
  }

  // Execute actions if provided
  let actionResults: any = {};
  if (actions && actions.length > 0) {
    console.log(`Executing ${actions.length} actions`);
    try {
      actionResults = await executeActions(page, actions, timeout);
    } catch (error) {
      console.error('Error executing actions:', error);
      // Continue without action results
      actionResults = { screenshots: [], actionContent: [], actionResults: [] };
    }
  }

  let headers = null,
    content = await page.content();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      (x) => x[0].toLowerCase() === "content-type",
    )?.[1];
    if (
      ct &&
      (ct[1].includes("application/json") || ct[1].includes("text/plain"))
    ) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    url: response ? response.url() : url,
    content,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
    ...actionResults,
  };
};

app.get("/health", async (req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

app.post("/scrape", async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
    actions,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : "None"}`);
  console.log(`Check Selector: ${check_selector ? check_selector : "None"}`);
  console.log(`Actions: ${actions ? JSON.stringify(actions) : "None"}`);
  console.log(`==================================================`);
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "URL is invalid or missing" });
  }

  await initializeBrowser();
  const context = await createContext(); // Create context outside the try block

  try {
    const page = await context.newPage();
    if (headers) {
      await page.setExtraHTTPHeaders(headers);
    }

    let result: Awaited<ReturnType<typeof scrapePage>>;

    try {
      // Strategy 1: Normal load
      console.log("Attempting strategy 1: Normal load");
      result = await scrapePage(
        page,
        url,
        "load",
        wait_after_load,
        timeout,
        check_selector,
        actions,
      );
    } catch (error) {
      console.log(
        "Strategy 1 failed, attempting strategy 2: Wait until networkidle",
      );
      // Strategy 2: Wait until networkidle
      // Note: Reusing the 'page' object after a failure can be risky, but we'll keep it for now.
      // A more advanced implementation might create a new page for the retry.
      result = await scrapePage(
        page,
        url,
        "networkidle",
        wait_after_load,
        timeout,
        check_selector,
        actions,
      );
    }

    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;
    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}`,
      );
    }

    const response: any = {
      url: result.url,
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError }),
    };

    // Add screenshots if available
    if (result.screenshots) {
      response.screenshots = result.screenshots;
    }
    if (result.actionContent) {
      response.actionContent = result.actionContent;
    }
    if (result.actionResults) {
      response.actionResults = result.actionResults;
    }
    res.json(response);
  } catch (finalError) {
    // This catches errors from both strategies
    console.error("Both scraping strategies failed.", finalError);
    return res
      .status(500)
      .json({ error: "An error occurred while fetching the page." });
  } finally {
    // This block ALWAYS runs, ensuring the context is closed.
    if (context) {
      await context.close();
    }
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

process.on("SIGINT", () => {
  shutdownBrowser().then(() => {
    console.log("Browser closed");
    process.exit(0);
  });
});
