import { z } from "zod";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { TimeoutError } from "../../error";
import { robustFetch } from "../../lib/fetch";
import { getInnerJSON } from "../../../../lib/html-transformer";

export async function scrapeURLWithPlaywright(
  meta: Meta,
  timeToRun: number | undefined,
): Promise<EngineScrapeResult> {
  const timeout = (timeToRun ?? 300000) + meta.options.waitFor;

  const requestBody: any = {
    url: meta.rewrittenUrl ?? meta.url,
    wait_after_load: meta.options.waitFor,
    timeout,
    headers: meta.options.headers,
  };

  if (meta.options.actions && meta.options.actions.length > 0) {
    requestBody.actions = meta.options.actions;
  }

  const response = await Promise.race([
    await robustFetch({
      url: process.env.PLAYWRIGHT_MICROSERVICE_URL!,
      headers: {
        "Content-Type": "application/json",
      },
      body: requestBody,
      method: "POST",
      logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
      schema: z.object({
        content: z.string(),
        url: z.string(),
        pageStatusCode: z.number(),
        pageError: z.string().optional(),
        contentType: z.string().optional(),
        screenshot: z.string().optional(),
        screenshots: z.array(z.string()).optional(),
        actionContent: z.array(z.object({
          url: z.string(),
          html: z.string(),
        })).optional(),
        actionResults: z.array(z.any()).optional(),
      }),
      mock: meta.mock,
      abort: AbortSignal.timeout(timeout),
    }),
    (async () => {
      await new Promise((resolve) => setTimeout(() => resolve(null), timeout));
      throw new TimeoutError(
        "Playwright was unable to scrape the page before timing out",
        { cause: { timeout } },
      );
    })(),
  ]);

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJSON(response.content);
  }

  const result: EngineScrapeResult = {
    url: response.url ?? meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "basic",
  };

  if (response.screenshot) {
    result.screenshot = response.screenshot;
  }

  if (meta.options.actions && meta.options.actions.length > 0 && (response.screenshots || response.actionContent || response.actionResults)) {
    result.actions = {
      screenshots: response.screenshots ?? [],
      scrapes: response.actionContent ?? [],
      javascriptReturns: (response.actionResults ?? [])
        .filter((x: any) => x.type === "executeJavascript")
        .map((x: any) => JSON.parse(x.result.return)),
      pdfs: (response.actionResults ?? [])
        .filter((x: any) => x.type === "pdf")
        .map((x: any) => x.result.link),
    };
  }

  return result;
}
