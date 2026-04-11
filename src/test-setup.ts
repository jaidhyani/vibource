import '@testing-library/jest-dom/vitest';

// jsdom does not implement SVG animated length properties or layout
// primitives. d3-zoom reads this.width.baseVal.value on the root <svg>
// element (see d3-zoom/src/zoom.js defaultExtent), and the visualization
// uses getBBox() to size directory labels. Stub both so the component can
// render to completion in tests.

function animatedLengthFromAttr(el: Element, attr: string): { baseVal: { value: number } } {
  const raw = el.getAttribute(attr);
  const value = raw ? parseFloat(raw) : 0;
  return { baseVal: { value: Number.isFinite(value) ? value : 0 } };
}

if (typeof SVGSVGElement !== 'undefined') {
  Object.defineProperty(SVGSVGElement.prototype, 'width', {
    configurable: true,
    get() { return animatedLengthFromAttr(this, 'width'); },
  });
  Object.defineProperty(SVGSVGElement.prototype, 'height', {
    configurable: true,
    get() { return animatedLengthFromAttr(this, 'height'); },
  });
}

if (typeof SVGElement !== 'undefined' && !('getBBox' in SVGElement.prototype)) {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 50, height: 12, top: 0, left: 0, right: 50, bottom: 12, toJSON: () => ({}) } as DOMRect);
}
