import { expect, test, type Locator, type Page } from "@playwright/test";

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("rotates a connected node from its context menu and persists orientation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();

  const gate = node(page, "neg-1");
  const input = page.getByTestId("handle-neg-1-input-a");
  const output = page.getByTestId("handle-neg-1-output-y");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  await gate.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "元件菜单" })).toBeVisible();
  await expect(page.getByText("当前方向 0°")).toBeVisible();
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();

  await expect(gate.locator(".circuit-node")).toHaveClass(/rotation-90/);
  const gateBox = await gate.boundingBox();
  const inputCenter = await center(input);
  const outputCenter = await center(output);
  if (!gateBox) throw new Error("Rotated gate is not visible");
  expect(inputCenter.y).toBeLessThan(gateBox.y + 12);
  expect(outputCenter.y).toBeGreaterThan(gateBox.y + gateBox.height - 12);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出工程" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Export has no path");
  await page.getByRole("button", { name: "清空" }).click();
  await page.getByLabel("选择三进制工程文件").setInputFiles(downloadPath);
  await expect(node(page, "neg-1").locator(".circuit-node")).toHaveClass(
    /rotation-90/,
  );

  await node(page, "neg-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();
  await expect(node(page, "neg-1").locator(".circuit-node")).toHaveClass(
    /rotation-180/,
  );
  const reversedBox = await node(page, "neg-1").boundingBox();
  const reversedInput = await center(page.getByTestId("handle-neg-1-input-a"));
  const reversedOutput = await center(page.getByTestId("handle-neg-1-output-y"));
  if (!reversedBox) throw new Error("Reversed gate is not visible");
  expect(reversedInput.x).toBeGreaterThan(
    reversedBox.x + reversedBox.width - 12,
  );
  expect(reversedOutput.x).toBeLessThan(reversedBox.x + 12);

  await node(page, "neg-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();
  await expect(node(page, "neg-1").locator(".circuit-node")).toHaveClass(
    /rotation-270/,
  );
  const invertedBox = await node(page, "neg-1").boundingBox();
  const invertedInput = await center(page.getByTestId("handle-neg-1-input-a"));
  const invertedOutput = await center(page.getByTestId("handle-neg-1-output-y"));
  if (!invertedBox) throw new Error("Inverted gate is not visible");
  expect(invertedInput.y).toBeGreaterThan(
    invertedBox.y + invertedBox.height - 12,
  );
  expect(invertedOutput.y).toBeLessThan(invertedBox.y + 12);

  await node(page, "neg-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();
  await expect(node(page, "neg-1").locator(".circuit-node")).toHaveClass(
    /rotation-0/,
  );

  await node(page, "neg-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "逆时针旋转" }).click();
  await expect(node(page, "neg-1").locator(".circuit-node")).toHaveClass(
    /rotation-270/,
  );
  await node(page, "neg-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();

  await node(page, "neg-1").click({ button: "right" });
  await page.screenshot({
    path: "test-results/node-context-menu-1440x900.png",
    fullPage: true,
  });
  await page.getByRole("menuitem", { name: "删除元件" }).click();
  await expect(node(page, "neg-1")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("rotates splitter trunk and branches onto opposite vertical sides", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByText("WASM v3")).toBeVisible();
  await page.getByRole("button", { name: "示例库" }).click();
  await page
    .getByRole("button", {
      name: "载入示例：3-trit 总线、分线与本地 Tunnel",
    })
    .click();

  const splitter = node(page, "split-word");
  const wireCount = await page.locator(".react-flow__edge").count();
  await splitter.click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺时针旋转" }).click();

  await expect(splitter.locator(".wiring-splitter")).toHaveClass(/rotation-90/);
  const splitterBox = await splitter.boundingBox();
  const trunk = await center(page.getByTestId("handle-split-word-input-trunk"));
  const branch = await center(
    page.getByTestId("handle-split-word-output-branch0"),
  );
  if (!splitterBox) throw new Error("Rotated splitter is not visible");
  expect(trunk.y).toBeLessThan(splitterBox.y + 12);
  expect(branch.y).toBeGreaterThan(
    splitterBox.y + splitterBox.height - 12,
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(wireCount);
  await page.screenshot({
    path: "test-results/rotated-splitter-1440x900.png",
    fullPage: true,
  });
});
