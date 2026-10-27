/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import type { Health, MapNode, PodBox } from "../service-map/service-map-model";
import type { LaidOutNode, Point, TopologyEdge, TopologyLayout, TopologyStatus } from "./topology-model";

const PAD = 24;
const ARROW = 7;
const MAX_POD_ROWS = 10;
const POD_ROW_HEIGHT = 26;

interface ThemePalette {
  mainBg: string;
  contentBg: string;
  layoutBg: string;
  border: string;
  borderFaint: string;
  textAccent: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDimmed: string;
  primary: string;
  ok: string;
  warn: string;
  err: string;
  fontFamily: string;
}

function readPalette(element: HTMLElement | null): ThemePalette {
  const style = element ? getComputedStyle(element) : getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;

  return {
    mainBg: pick("--mainBackground", "#161922"),
    contentBg: pick("--contentColor", "#1e222d"),
    layoutBg: pick("--layoutBackground", "#252a37"),
    border: pick("--borderColor", "#3a4052"),
    borderFaint: pick("--borderFaintColor", "#2c3140"),
    textAccent: pick("--textColorAccent", "#f3f5f8"),
    textPrimary: pick("--textColorPrimary", "#dcdfe6"),
    textSecondary: pick("--textColorSecondary", "#a3aab8"),
    textTertiary: pick("--textColorTertiary", "#7b8394"),
    textDimmed: pick("--textColorDimmed", "#5c6475"),
    primary: pick("--primary", "#7c6af6"),
    ok: pick("--colorOk", "#38b26f"),
    warn: pick("--colorWarning", "#e59934"),
    err: pick("--colorError", "#e55353"),
    fontFamily: style.fontFamily || "system-ui, -apple-system, Segoe UI, sans-serif",
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A path through right-angled points, its corners rounded. */
export function roundedSvgPath(points: Point[], radius = 8): string {
  const towards = (from: Point, to: Point, distance: number) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;

    return {
      x: round(from.x + ((to.x - from.x) / length) * distance),
      y: round(from.y + ((to.y - from.y) / length) * distance),
    };
  };
  const [first, ...rest] = points;
  let d = `M${round(first.x)} ${round(first.y)}`;

  rest.forEach((point, index) => {
    const previous = points.at(index) as Point;
    const next = rest.at(index + 1);

    if (!next) {
      d += `L${round(point.x)} ${round(point.y)}`;

      return;
    }

    const r = Math.min(
      radius,
      Math.hypot(point.x - previous.x, point.y - previous.y) / 2,
      Math.hypot(next.x - point.x, next.y - point.y) / 2,
    );
    const into = towards(point, previous, r);
    const out = towards(point, next, r);

    d += `L${into.x} ${into.y}Q${round(point.x)} ${round(point.y)} ${out.x} ${out.y}`;
  });

  return d;
}

export function edgeGeometry(points: Point[]): { line: Point[]; arrow: string; vertical: boolean } {
  const end = points.at(-1) as Point;
  const before = points.at(-2) as Point;
  const vertical = Math.abs(end.x - before.x) < 0.5;
  const direction = vertical ? (end.y >= before.y ? 1 : -1) : end.x >= before.x ? 1 : -1;
  const line = [
    ...points.slice(0, -1),
    vertical ? { x: end.x, y: end.y - ARROW * direction } : { x: end.x - ARROW * direction, y: end.y },
  ];
  const arrow = vertical
    ? `M${end.x - 4} ${end.y - ARROW * direction}L${end.x} ${end.y}L${end.x + 4} ${end.y - ARROW * direction}Z`
    : `M${end.x - ARROW * direction} ${end.y - 4}L${end.x} ${end.y}L${end.x - ARROW * direction} ${end.y + 4}Z`;

  return { line, arrow, vertical };
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text || maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  let cut = text.length;

  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) {
    cut--;
  }

  return `${text.slice(0, cut)}…`;
}

function drawRoundedBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill?: string,
  stroke?: string,
  dashed = false,
  lineWidth = 1,
) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);

  if (fill && fill !== "transparent") {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.stroke();
  }

  ctx.restore();
}

function drawLeftStripe(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, r: number, color: string) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, 12, h, [r, 0, 0, r]);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 3.5, h);
  ctx.restore();
}

function createExportCanvas(
  width: number,
  height: number,
  palette: ThemePalette,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined {
  const totalW = Math.max(400, Math.ceil(width + PAD * 2));
  const totalH = Math.max(260, Math.ceil(height + PAD * 2));
  const scale = Math.min(2, 8192 / Math.max(totalW, totalH));
  const canvas = document.createElement("canvas");

  canvas.width = Math.round(totalW * scale);
  canvas.height = Math.round(totalH * scale);

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return undefined;
  }

  ctx.scale(scale, scale);
  ctx.fillStyle = palette.mainBg;
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.translate(PAD, PAD);
  ctx.textBaseline = "middle";

  return { canvas, ctx };
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  const trigger = (href: string) => {
    const link = document.createElement("a");

    link.download = filename;
    link.href = href;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  if (typeof canvas.toBlob === "function") {
    canvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);

        trigger(url);
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      } else {
        trigger(canvas.toDataURL("image/png"));
      }
    }, "image/png");
  } else {
    trigger(canvas.toDataURL("image/png"));
  }
}

export function exportTopologyPng(options: {
  element: HTMLElement | null;
  layout: TopologyLayout;
  edges: TopologyEdge[];
  selected?: string;
  path: { nodes: Set<string>; edges: Set<string> };
  filename: string;
}) {
  const { element, layout, edges, selected, path, filename } = options;
  const palette = readPalette(element);
  const surface = createExportCanvas(layout.width, layout.height, palette);

  if (!surface) {
    return;
  }

  const { canvas, ctx } = surface;
  const statusColor: Record<TopologyStatus, string> = {
    ok: palette.ok,
    warn: palette.warn,
    err: palette.err,
    idle: palette.textDimmed,
  };

  // 1. Groups
  for (const group of layout.groups) {
    drawRoundedBox(
      ctx,
      group.x,
      group.y,
      group.width,
      group.height,
      14,
      group.outsideView ? "transparent" : palette.contentBg,
      palette.borderFaint,
      group.outsideView,
      1,
    );

    ctx.font = `600 13px ${palette.fontFamily}`;
    ctx.fillStyle = group.outsideView ? palette.textSecondary : palette.textAccent;
    const labelText = fitText(ctx, group.label, group.width - 28);

    ctx.fillText(labelText, group.x + 14, group.y + 18);

    if (group.meta) {
      const labelW = ctx.measureText(labelText).width;

      ctx.font = `400 11.5px ${palette.fontFamily}`;
      ctx.fillStyle = palette.textTertiary;
      ctx.fillText(
        fitText(ctx, group.meta, Math.max(0, group.width - 36 - labelW)),
        group.x + 14 + labelW + 8,
        group.y + 18,
      );
    }
  }

  // 2. Edges
  const highlight = selected !== undefined;
  const drawnEdges = edges.filter((e) => (layout.routes[e.id]?.length ?? 0) >= 2);

  for (const edge of drawnEdges) {
    const points = layout.routes[edge.id];
    const { line, arrow } = edgeGeometry(points);
    const onPath = path.edges.has(edge.id);
    const stroke = onPath
      ? palette.primary
      : edge.type === "calls"
        ? palette.primary
        : edge.type === "exposes"
          ? palette.textTertiary
          : palette.textSecondary;

    ctx.save();
    ctx.globalAlpha = highlight && !onPath ? 0.2 : 1;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = onPath ? 2.5 : 1.5;
    ctx.setLineDash(edge.type === "calls" ? [6, 5] : []);
    ctx.stroke(new Path2D(roundedSvgPath(line)));
    ctx.setLineDash([]);
    ctx.fillStyle = stroke;
    ctx.fill(new Path2D(arrow));
    ctx.restore();
  }

  // 3. Nodes
  const renderNode = (node: LaidOutNode) => {
    const isSelected = selected === node.id;
    const dimmed = highlight && !path.nodes.has(node.id);
    const hasExtraRow = (node.kind === "Namespace" && node.hosts.length > 0) || node.attachments.length > 0;
    const rows = hasExtraRow ? 4 : 3;
    const rowGap = 15;
    const startY = node.y + (node.height - (rows - 1) * rowGap) / 2;
    const innerX = node.x + 14;
    const maxW = node.width - 26;

    ctx.save();
    ctx.globalAlpha = dimmed ? 0.4 : 1;

    drawRoundedBox(
      ctx,
      node.x,
      node.y,
      node.width,
      node.height,
      10,
      node.outsideView ? palette.mainBg : palette.layoutBg,
      isSelected ? palette.primary : palette.border,
      node.outsideView,
      isSelected ? 2 : 1,
    );
    drawLeftStripe(ctx, node.x, node.y, node.height, 10, statusColor[node.status] ?? palette.ok);

    // Row 1: kind + flags
    ctx.font = `600 10.5px ${palette.fontFamily}`;
    ctx.fillStyle = palette.textTertiary;
    const kindText = `${node.kind}${node.outsideView && node.namespace ? ` · ${node.namespace}` : ""}`.toUpperCase();
    ctx.fillText(fitText(ctx, kindText, maxW - (node.flags.length > 0 ? 70 : 0)), innerX, startY);

    let flagRight = node.x + node.width - 12;

    for (const flag of node.flags.slice(0, 2).reverse()) {
      ctx.font = `600 10.5px ${palette.fontFamily}`;
      const fw = Math.min(90, ctx.measureText(flag.text).width + 12);

      drawRoundedBox(ctx, flagRight - fw, startY - 8, fw, 16, 8, "rgba(229, 153, 52, 0.18)");
      ctx.fillStyle = palette.warn;
      ctx.fillText(fitText(ctx, flag.text, fw - 10), flagRight - fw + 6, startY);
      flagRight -= fw + 4;
    }

    // Row 2: name
    ctx.font = `600 13px ${palette.fontFamily}`;
    ctx.fillStyle = palette.textAccent;
    ctx.fillText(fitText(ctx, node.name, maxW), innerX, startY + rowGap);

    // Row 3: summary + pod squares
    ctx.font = `400 11.5px ${palette.fontFamily}`;
    ctx.fillStyle = palette.textTertiary;
    const summaryText = fitText(ctx, node.summary, maxW);
    ctx.fillText(summaryText, innerX, startY + rowGap * 2);

    if (node.kind !== "Pod" && node.pods.length > 0) {
      const maxPods = node.kind === "Namespace" ? 16 : 12;
      let podX = innerX + (node.summary ? ctx.measureText(summaryText).width + 6 : 0);
      const podY = startY + rowGap * 2 - 3.5;

      for (const pod of node.pods.slice(0, maxPods)) {
        if (podX + 7 > node.x + node.width - 12) break;
        drawRoundedBox(ctx, podX, podY, 7, 7, 2, statusColor[pod.status] ?? palette.ok);
        podX += 10;
      }
    }

    // Row 4: hosts or attachments
    if (node.kind === "Namespace" && node.hosts.length > 0) {
      const hostSummary = node.hosts.length > 1 ? `${node.hosts[0]} +${node.hosts.length - 1}` : node.hosts[0];
      ctx.font = `400 11.5px ${palette.fontFamily}`;
      ctx.fillStyle = palette.textSecondary;
      ctx.fillText(fitText(ctx, hostSummary, maxW), innerX, startY + rowGap * 3);
    } else if (node.attachments.length > 0) {
      let chipX = innerX;
      const chipY = startY + rowGap * 3 - 8;

      for (const short of [...new Set(node.attachments.map((a) => a.short))]) {
        ctx.font = `400 10.5px ${palette.fontFamily}`;
        const cw = ctx.measureText(short).width + 10;

        if (chipX + cw > node.x + node.width - 10) break;
        drawRoundedBox(ctx, chipX, chipY, cw, 16, 4, palette.mainBg);
        ctx.fillStyle = palette.textSecondary;
        ctx.fillText(short, chipX + 5, chipY + 8);
        chipX += cw + 4;
      }
    }

    ctx.restore();
  };

  for (const node of layout.nodes) {
    renderNode(node);
  }

  // 4. Edge labels
  const labelsOut = new Map<string, Set<string>>();

  for (const edge of drawnEdges) {
    if (edge.type !== "calls" && edge.label) {
      labelsOut.set(edge.from, (labelsOut.get(edge.from) ?? new Set<string>()).add(edge.label));
    }
  }

  const byTarget = (edge: TopologyEdge) => edge.type === "calls" || (labelsOut.get(edge.from)?.size ?? 0) > 1;
  const labelGroups = new Map<string, TopologyEdge[]>();

  for (const edge of drawnEdges) {
    if (!edge.label || (highlight && !path.edges.has(edge.id))) continue;
    const key = byTarget(edge) ? `in:${edge.to}:${edge.label}` : `out:${edge.from}:${edge.label}`;
    labelGroups.set(key, [...(labelGroups.get(key) ?? []), edge]);
  }

  for (const members of labelGroups.values()) {
    const edge = members[0];
    const points = layout.routes[edge.id];
    const atEnd = byTarget(edge);
    const anchor = (atEnd ? points.at(-1) : points.at(0)) as Point;
    const neighbour = (atEnd ? points.at(-2) : points.at(1)) as Point;
    const short = edge.label.length > 22 ? `${edge.label.slice(0, 21)}…` : edge.label;
    const text = members.length > 1 ? `${short} ×${members.length}` : short;
    const vertical = Math.abs(anchor.x - neighbour.x) < 0.5;

    ctx.save();
    ctx.font = `400 10.5px ${palette.fontFamily}`;
    ctx.strokeStyle = palette.mainBg;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.fillStyle = edge.type === "calls" ? palette.primary : palette.textSecondary;

    if (vertical) {
      ctx.textAlign = "left";
      const x = round(anchor.x + 8);
      const y = round((anchor.y + neighbour.y) / 2);
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    } else {
      const rightwards = atEnd ? anchor.x >= neighbour.x : neighbour.x >= anchor.x;
      const x = round(atEnd ? anchor.x - (ARROW + 4) * (rightwards ? 1 : -1) : anchor.x + 6 * (rightwards ? 1 : -1));
      const y = round(anchor.y - 8);
      ctx.textAlign = atEnd === rightwards ? "right" : "left";
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }

    ctx.restore();
  }

  downloadCanvas(canvas, filename);
}

const healthText: Record<Health, string> = {
  ok: "Healthy",
  warn: "Degraded",
  err: "Failing",
  missing: "Doesn't exist",
  idle: "Idle",
};

export function exportServiceMapPng(options: {
  element: HTMLElement | null;
  layout: TopologyLayout;
  lines: { id: string; tone: "fail" | "risk" | "decl"; inferred?: boolean }[];
  nodes: Record<string, MapNode>;
  boxes: Map<string, PodBox>;
  roleOf: (id: string) => "root" | "failing" | "missing" | "atRisk" | "healthy";
  groupBy: "workload" | "node";
  severity?: "critical" | "warning";
  filename: string;
}) {
  const { element, layout, lines, nodes, boxes, roleOf, groupBy, severity, filename } = options;
  const isWarning = severity === "warning";
  const palette = readPalette(element);
  const incidentTone = isWarning ? palette.warn : palette.err;
  const surface = createExportCanvas(layout.width, layout.height, palette);

  if (!surface) {
    return;
  }

  const { canvas, ctx } = surface;
  const healthColor: Record<Health, string> = {
    ok: palette.ok,
    warn: palette.warn,
    err: palette.err,
    missing: isWarning ? palette.warn : palette.err,
    idle: palette.textDimmed,
  };

  // 1. Edges
  for (const item of lines) {
    const points = layout.routes[item.id];

    if (!points || points.length < 2) continue;

    const { line, arrow } = edgeGeometry(points);
    const stroke = item.tone === "fail" ? palette.err : item.tone === "risk" ? palette.warn : palette.textDimmed;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = item.tone === "fail" ? 2 : 1.5;
    ctx.setLineDash(item.inferred ? [6, 5] : []);
    ctx.stroke(new Path2D(roundedSvgPath(line)));
    ctx.setLineDash([]);
    ctx.fillStyle = stroke;
    ctx.fill(new Path2D(arrow));
    ctx.restore();
  }

  // 2. Cards & PodBoxes
  for (const placed of layout.nodes) {
    const box = boxes.get(placed.id);

    if (box) {
      const border = box.root
        ? incidentTone
        : box.health === "err"
          ? palette.err
          : box.atRisk
            ? palette.warn
            : palette.border;

      drawRoundedBox(
        ctx,
        placed.x,
        placed.y,
        placed.width,
        placed.height,
        10,
        palette.layoutBg,
        border,
        Boolean(box.behind),
        box.root ? 1.5 : 1,
      );

      const innerX = placed.x + 12;
      const maxW = placed.width - 24;

      ctx.font = `600 13px ${palette.fontFamily}`;
      ctx.fillStyle = palette.textAccent;
      ctx.fillText(fitText(ctx, box.title, maxW - (box.badge ? 75 : 0)), innerX, placed.y + 19);

      if (box.badge) {
        ctx.font = `600 10.5px ${palette.fontFamily}`;
        const bw = ctx.measureText(box.badge).width + 12;
        const bx = placed.x + placed.width - 12 - bw;
        drawRoundedBox(ctx, bx, placed.y + 11, bw, 16, 8, "rgba(229, 83, 83, 0.16)");
        ctx.fillStyle = palette.err;
        ctx.fillText(box.badge, bx + 6, placed.y + 19);
      }

      ctx.font = `600 10.5px ${palette.fontFamily}`;
      ctx.fillStyle = palette.textTertiary;
      const subText = (box.behind ? `${box.sub} · behind ${box.behind}` : box.sub).toUpperCase();
      ctx.fillText(fitText(ctx, subText, maxW), innerX, placed.y + 36);

      box.pods.slice(0, MAX_POD_ROWS).forEach((pod, idx) => {
        const rowY = placed.y + 52 + idx * POD_ROW_HEIGHT + POD_ROW_HEIGHT / 2;

        ctx.beginPath();
        ctx.arc(placed.x + 18, rowY, 4, 0, Math.PI * 2);
        ctx.fillStyle = healthColor[pod.health] ?? palette.ok;
        ctx.fill();

        const rightInfo = (groupBy === "workload" ? pod.node : pod.ownerId.split("/").at(-1)) ?? "";
        ctx.font = `400 11px ${palette.fontFamily}`;
        ctx.fillStyle = palette.textDimmed;
        const rightW = ctx.measureText(rightInfo).width;
        ctx.fillText(rightInfo, placed.x + placed.width - 14 - rightW, rowY);

        ctx.font = `400 11.5px ${palette.fontFamily}`;
        ctx.fillStyle =
          pod.health === "err" ? palette.err : pod.health === "warn" ? palette.warn : palette.textSecondary;
        const statusW = ctx.measureText(pod.status).width;
        const statusX = placed.x + placed.width - 22 - rightW - statusW;
        ctx.fillText(pod.status, statusX, rowY);

        ctx.font = `400 12px ${palette.fontFamily}`;
        ctx.fillStyle = palette.textPrimary;
        ctx.fillText(fitText(ctx, pod.name, Math.max(40, statusX - (placed.x + 30) - 8)), placed.x + 30, rowY);
      });

      if (box.pods.length > MAX_POD_ROWS) {
        const moreY = placed.y + 52 + MAX_POD_ROWS * POD_ROW_HEIGHT + 10;
        ctx.font = `400 11.5px ${palette.fontFamily}`;
        ctx.fillStyle = palette.textTertiary;
        ctx.fillText(`+${box.pods.length - MAX_POD_ROWS} pods`, innerX, moreY);
      }

      continue;
    }

    const node = nodes[placed.id];

    if (!node) continue;

    const role = roleOf(node.id);
    const isRoot = role === "root";
    const isMissing = role === "missing" || node.health === "missing";
    const border = isRoot || isMissing ? incidentTone : node.health === "err" ? palette.err : palette.border;

    ctx.save();
    if (role === "healthy") {
      ctx.globalAlpha = 0.6;
    }

    drawRoundedBox(
      ctx,
      placed.x,
      placed.y,
      placed.width,
      placed.height,
      10,
      isMissing ? palette.mainBg : palette.layoutBg,
      border,
      isMissing,
      isRoot ? 1.5 : 1,
    );
    drawLeftStripe(ctx, placed.x, placed.y, placed.height, 10, healthColor[node.health] ?? palette.ok);

    const innerX = placed.x + 14;
    const maxW = placed.width - 26;
    const startY = placed.y + placed.height / 2 - 15;

    ctx.font = `600 10.5px ${palette.fontFamily}`;
    ctx.fillStyle = palette.textTertiary;
    const kindText = `${node.kind}${node.namespace ? ` · ${node.namespace}` : ""}`.toUpperCase();
    ctx.fillText(fitText(ctx, kindText, maxW - (node.badge ? 60 : 0)), innerX, startY);

    if (node.badge) {
      ctx.font = `600 10.5px ${palette.fontFamily}`;
      const bw = ctx.measureText(node.badge).width + 12;
      const bx = placed.x + placed.width - 12 - bw;
      drawRoundedBox(ctx, bx, startY - 8, bw, 16, 8, "rgba(229, 83, 83, 0.16)");
      ctx.fillStyle = palette.err;
      ctx.fillText(node.badge, bx + 6, startY);
    }

    ctx.font = `600 13px ${palette.fontFamily}`;
    ctx.fillStyle = palette.textAccent;
    ctx.fillText(fitText(ctx, node.name, maxW), innerX, startY + 15);

    ctx.font = `400 11.5px ${palette.fontFamily}`;
    ctx.fillStyle = node.health === "err" ? palette.err : palette.textTertiary;
    const subText = node.health === "missing" ? "does not exist" : node.sub || healthText[node.health];
    ctx.fillText(fitText(ctx, subText, maxW), innerX, startY + 30);

    if (isRoot) {
      const tag = "Suspected root cause";
      ctx.font = `600 10px ${palette.fontFamily}`;
      const tw = ctx.measureText(tag).width + 12;
      drawRoundedBox(ctx, placed.x + 12, placed.y - 9, tw, 16, 4, incidentTone);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tag, placed.x + 18, placed.y - 1);
    }

    ctx.restore();
  }

  downloadCanvas(canvas, filename);
}
