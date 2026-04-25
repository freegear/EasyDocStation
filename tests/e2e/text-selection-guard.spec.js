import { test, expect } from '@playwright/test'

async function dragSelectRange(page, locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Failed to resolve bounding box for selectable text')

  const startX = box.x + 24
  const startY = box.y + box.height / 2
  const endX = box.x + Math.max(80, box.width - 24)
  const endY = startY

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(endX, endY, { steps: 12 })
  await page.mouse.up()
}

test.describe('text selection click guard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?e2e=selection-guard')
  })

  test('post body: drag selection suppresses next card click', async ({ page }) => {
    const card = page.getByTestId('post-body-text-card')
    const text = page.getByTestId('post-body-text')
    const count = page.getByTestId('post-open-count')

    await expect(count).toHaveText('0')
    await dragSelectRange(page, text)

    await expect.poll(async () => {
      return page.evaluate(() => window.getSelection()?.toString().trim().length || 0)
    }).toBeGreaterThan(0)

    await expect(count).toHaveText('0')

    await page.keyboard.press('Escape')
    await card.click({ position: { x: 20, y: 20 } })
    await expect(count).toHaveText('1')
  })

  test('comment body: drag selection suppresses next card click', async ({ page }) => {
    const card = page.getByTestId('comment-body-text-card')
    const text = page.getByTestId('comment-body-text')
    const count = page.getByTestId('comment-open-count')

    await expect(count).toHaveText('0')
    await dragSelectRange(page, text)

    await expect.poll(async () => {
      return page.evaluate(() => window.getSelection()?.toString().trim().length || 0)
    }).toBeGreaterThan(0)

    await expect(count).toHaveText('0')

    await page.keyboard.press('Escape')
    await card.click({ position: { x: 20, y: 20 } })
    await expect(count).toHaveText('1')
  })
})
