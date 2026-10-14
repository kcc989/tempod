import { Option, Schema } from "effect";
import type { Page } from "@playwright/test";

export const pressMod = async (page: Page, key: string) => {
  const platform = await page.evaluate(() => {
    const data = "userAgentData" in navigator ? navigator.userAgentData : null;

    return { data, platform: navigator.platform, userAgent: navigator.userAgent };
  });

  const browser = Schema.decodeUnknownOption(
    Schema.Struct({ userAgentData: Schema.Struct({ platform: Schema.String }) }),
  )({ userAgentData: platform.data });

  const name = Option.isSome(browser) ? browser.value.userAgentData.platform : platform.platform;
  const mac = /mac|iphone|ipad|ipod/i.test(name) || /Mac OS X/.test(platform.userAgent);

  await page.keyboard.press(`${mac ? "Meta" : "Control"}+${key}`);
};
