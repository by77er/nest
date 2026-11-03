// An SVG from a message: sanitized (rich/svg.ts), then shown only as an image from a data: URL; refused
// with a notice when it's too large or isn't a clean SVG.
import { Notice, SvgFigure } from "../../layout";
import { sanitizeSvg, svgDataUrl } from "../../rich/svg";

export function SvgBlock({ source }: { source: string }) {
  const s = sanitizeSvg(source);
  if (!s.ok) {
    return (
      <Notice tone="warning" title="Diagram not shown">
        {s.reason}
      </Notice>
    );
  }
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(s.svg)?.[1]?.trim();
  return <SvgFigure url={svgDataUrl(s.svg)} source={s.svg} label={title || "Diagram"} />;
}
