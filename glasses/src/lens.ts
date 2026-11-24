// Draws pages on the 576×288 G2 display. One page = one text block, or a header + a list.
import {
  type EvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ListContainerProperty,
  ListItemContainerProperty,
} from '@evenrealities/even_hub_sdk'

const W = 576
const H = 288

let bridge: EvenAppBridge
let started = false
let currentText = ''

export function initLens(b: EvenAppBridge) {
  bridge = b
}

/** G2 drops glyphs it can't draw (most emoji). Keep to plain text. */
export function clean(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n·]/g, '')
}

/** Like fit(), but keeps line breaks (for reading a full message). */
export function block(s: string, n: number) {
  const c = clean(s).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return c.length <= n ? c : c.slice(0, n - 3).trimEnd() + '...'
}

export function fit(s: string, n: number) {
  const c = clean(s).replace(/\s+/g, ' ').trim()
  return c.length <= n ? c : c.slice(0, n - 3).trimEnd() + '...'
}

async function show(page: { textObject?: TextContainerProperty[]; listObject?: ListContainerProperty[] }) {
  const total = (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0)
  if (!started) {
    started = true
    await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: total, ...page }))
  } else {
    await bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: total, ...page }))
  }
}

/** Full-screen text that takes taps, double taps and swipes. */
export async function text(content: string) {
  currentText = clean(content)
  await show({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: W,
        height: H,
        borderWidth: 0,
        paddingLength: 8,
        containerID: 1,
        containerName: 'main',
        content: currentText,
        isEventCapture: 1,
      }),
    ],
  })
}

/** Update the full-screen text in place (cheap, no flicker). */
export async function update(content: string) {
  const c = clean(content)
  if (c === currentText) return
  currentText = c
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: c }))
}

/** Header text on top, a tappable list below. Items are cut to 60 chars, at most 20. */
export async function list(header: string, items: string[], headerHeight = 76) {
  currentText = ''
  const names = items.slice(0, 20).map(i => fit(i, 60))
  await show({
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: W,
        height: headerHeight,
        borderWidth: 0,
        paddingLength: 8,
        containerID: 1,
        containerName: 'head',
        content: clean(header),
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: headerHeight,
        width: W,
        height: H - headerHeight,
        borderWidth: 0,
        paddingLength: 4,
        containerID: 2,
        containerName: 'list',
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({ itemCount: names.length, itemWidth: W - 16, isItemSelectBorderEn: 1, itemName: names }),
      }),
    ],
  })
}

export function exit() {
  return bridge.shutDownPageContainer(1)
}
