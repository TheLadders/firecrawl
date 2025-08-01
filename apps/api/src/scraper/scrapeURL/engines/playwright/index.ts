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

  const response = await Promise.race([
    await robustFetch({
      url: process.env.PLAYWRIGHT_MICROSERVICE_URL!,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        url: meta.rewrittenUrl ?? meta.url,
        wait_after_load: meta.options.waitFor,
        timeout,
        headers: meta.options.headers,
      },
      method: "POST",
      logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
      schema: z.object({
        content: z.string(),
        pageStatusCode: z.number(),
        url: z.string(),
        pageError: z.string().optional(),
        contentType: z.string().optional(),
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

  return {
    url: response.url ?? meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "basic",
  };
}
