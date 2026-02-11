const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");

const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN = 0.65;

function hex6NoHash(hex) {
  return hex.replace("#", "").toUpperCase();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hexToRgb(hex) {
  const h = hex6NoHash(hex);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const to2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `${to2(r)}${to2(g)}${to2(b)}`.toUpperCase();
}

function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function parseTheme(themeMarkdownPath) {
  const raw = fs.readFileSync(themeMarkdownPath, "utf8");
  const colors = {};

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/-\s+\*\*([^*]+)\*\*:\s+`(#[0-9a-fA-F]{6})`/);
    if (m) colors[m[1].trim()] = hex6NoHash(m[2]);
  }

  const headerFont = (raw.match(/-\s+\*\*Headers\*\*:\s+(.+)\s*$/m) || [])[1]?.trim();
  const bodyFont = (raw.match(/-\s+\*\*Body Text\*\*:\s+(.+)\s*$/m) || [])[1]?.trim();

  return {
    name: (raw.match(/^#\s+(.+)\s*$/m) || [])[1]?.trim() || "Theme",
    colors,
    fonts: { headerFont, bodyFont },
  };
}

function pickWindowsFontPair(themeFonts) {
  const headerFallback = "Segoe UI Semibold";
  const bodyFallback = "Segoe UI";

  const header = themeFonts?.headerFont?.toLowerCase().includes("bold")
    ? headerFallback
    : headerFallback;
  const body = bodyFallback;

  return { header, body };
}

function makeShadow() {
  return { type: "outer", color: "000000", blur: 8, offset: 3, angle: 135, opacity: 0.14 };
}

function addBeanMotif(slide, pres, colors) {
  const dots = [
    { x: SLIDE_W - 1.55, y: 0.45, c: colors.accent2 },
    { x: SLIDE_W - 1.15, y: 0.40, c: colors.accent1 },
    { x: SLIDE_W - 0.78, y: 0.50, c: colors.accent2 },
    { x: SLIDE_W - 1.30, y: 0.68, c: colors.accent1 },
    { x: SLIDE_W - 0.92, y: 0.72, c: colors.accent2 },
  ];
  for (const d of dots) {
    slide.addShape(pres.shapes.OVAL, {
      x: d.x,
      y: d.y,
      w: 0.22,
      h: 0.14,
      fill: { color: d.c },
      line: { color: d.c },
      rotate: 18,
    });
  }
}

function addChrome(slide, pres, colors, opts) {
  const isDark = Boolean(opts?.dark);
  const bg = isDark ? colors.dark : colors.bg;

  slide.background = { color: bg };

  slide.addShape(pres.shapes.RECTANGLE, {
    x: 0,
    y: 0,
    w: 0.18,
    h: SLIDE_H,
    fill: { color: isDark ? colors.accent1 : colors.accent2 },
    line: { color: isDark ? colors.accent1 : colors.accent2 },
  });

  addBeanMotif(slide, pres, colors);

  if (!opts?.hideFooter) {
    slide.addText(opts?.footerLeft || "", {
      x: 0.35,
      y: SLIDE_H - 0.42,
      w: 6.5,
      h: 0.3,
      fontFace: opts?.fontBody,
      fontSize: 10,
      color: isDark ? mix(colors.bg, "FFFFFF", 0.35) : mix(colors.text, "FFFFFF", 0.25),
      margin: 0,
    });

    slide.addText(String(opts?.pageNumber ?? ""), {
      x: SLIDE_W - 0.95,
      y: SLIDE_H - 0.45,
      w: 0.6,
      h: 0.3,
      fontFace: opts?.fontBody,
      fontSize: 10,
      align: "right",
      color: isDark ? mix(colors.bg, "FFFFFF", 0.30) : mix(colors.text, "FFFFFF", 0.25),
      margin: 0,
    });
  }
}

function addTitle(slide, colors, fonts, title, subtitle) {
  slide.addText(title, {
    x: 0.55,
    y: 1.5,
    w: SLIDE_W - 1.2,
    h: 1.4,
    fontFace: fonts.header,
    fontSize: 46,
    color: colors.bgText,
    bold: true,
    margin: 0,
  });

  slide.addShape("rect", {
    x: 0.55,
    y: 3.25,
    w: 6.7,
    h: 0.55,
    fill: { color: colors.accent2, transparency: 12 },
    line: { color: colors.accent2, transparency: 100 },
  });

  slide.addText(subtitle, {
    x: 0.75,
    y: 3.33,
    w: 6.3,
    h: 0.4,
    fontFace: fonts.body,
    fontSize: 16,
    color: colors.bgText,
    margin: 0,
  });
}

function addH1(slide, colors, fonts, h1, h2) {
  slide.addText(h1, {
    x: 0.55,
    y: 0.62,
    w: SLIDE_W - 1.2,
    h: 0.6,
    fontFace: fonts.header,
    fontSize: 34,
    color: colors.text,
    bold: true,
    margin: 0,
  });

  if (h2) {
    slide.addText(h2, {
      x: 0.55,
      y: 1.2,
      w: SLIDE_W - 1.2,
      h: 0.4,
      fontFace: fonts.body,
      fontSize: 14,
      color: mix(colors.text, "FFFFFF", 0.35),
      margin: 0,
    });
  }
}

function addCard(slide, pres, colors, rect, opts) {
  slide.addShape(pres.shapes.RECTANGLE, {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    fill: { color: opts?.fill ?? colors.card },
    line: { color: opts?.line ?? mix(colors.text, "FFFFFF", 0.80), width: 0.7 },
    shadow: opts?.shadow ? makeShadow() : undefined,
  });
}

function normalizeParagraphs(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("生成日期："))
    .join("\n");
}

function stripMd(text) {
  return String(text)
    .replaceAll("**", "")
    .replaceAll("*", "")
    .replaceAll("`", "")
    .trim();
}

function splitIntroAndBullets(text) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const firstBullet = lines.findIndex((l) => l.startsWith("- "));
  if (firstBullet < 0) return { intro: lines.join("\n"), bullets: [] };

  const intro = lines.slice(0, firstBullet).join("\n").trim();
  const bullets = lines.slice(firstBullet).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  return { intro, bullets };
}

function sectionBetween(md, startHeading, endHeadingOrNull) {
  const startIdx = md.indexOf(startHeading);
  if (startIdx < 0) return "";
  const after = md.slice(startIdx + startHeading.length);
  if (!endHeadingOrNull) return after.trim();
  const endIdx = after.indexOf(endHeadingOrNull);
  if (endIdx < 0) return after.trim();
  return after.slice(0, endIdx).trim();
}

function parseBullets(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) out.push(trimmed.slice(2).trim());
  }
  return out;
}

function splitBoldPrefix(bullet) {
  const m = bullet.match(/^\*\*([^*]+)\*\*[：:]\s*(.+)$/);
  if (!m) return { title: null, body: bullet };
  return { title: m[1].trim(), body: m[2].trim() };
}

function parseDetailedAnalysis(raw) {
  const blocks = raw.split(/\r?\n###\s+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const titleLine = lines[0].trim();
    const body = normalizeParagraphs(lines.slice(1).join("\n"));
    out.push({ title: titleLine, body });
  }
  return out;
}

function parseSources(raw) {
  const sources = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = trimmed.match(/^\[(\d+)\]\s+(.+?)\.\s+(https?:\/\/\S+)\s*$/);
    if (m) sources.push({ id: m[1], title: m[2].trim(), url: m[3].trim() });
  }
  return sources;
}

function addBullets(slide, fonts, colors, bullets, rect) {
  const runs = [];
  for (let i = 0; i < bullets.length; i++) {
    runs.push({
      text: bullets[i],
      options: {
        bullet: true,
        breakLine: i !== bullets.length - 1,
      },
    });
  }

  slide.addText(runs, {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    fontFace: fonts.body,
    fontSize: 16,
    color: colors.text,
    margin: 0,
    paraSpaceAfter: 6,
  });
}

function buildDeck(mdPath, outPath, themeSlug) {
  const md = fs.readFileSync(mdPath, "utf8");
  const title = (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || "Deep Research";
  const date = (md.match(/^生成日期：\s*([0-9-]+)\s*$/m) || [])[1]?.trim() || "";

  const themePath = path.join(
    process.env.USERPROFILE || "",
    ".agents",
    "skills",
    "theme-factory",
    "themes",
    `${themeSlug}.md`,
  );
  const theme = parseTheme(themePath);
  const fonts = pickWindowsFontPair(theme.fonts);

  const mustard = theme.colors["Mustard Yellow"] || theme.colors["Electric Blue"] || "F4A900";
  const terracotta = theme.colors["Terracotta"] || theme.colors["Neon Cyan"] || "C1666B";
  const beige = theme.colors["Warm Beige"] || theme.colors["Cream"] || theme.colors["White"] || "D4B896";
  const chocolate = theme.colors["Chocolate Brown"] || theme.colors["Dark Gray"] || theme.colors["Deep Navy"] || "4A403A";

  const palette = {
    accent1: mustard,
    accent2: terracotta,
    bg: mix(beige, "FFFFFF", 0.68),
    card: mix("FFFFFF", beige, 0.12),
    text: chocolate,
    dark: mix(chocolate, "000000", 0.30),
    bgText: mix("FFFFFF", beige, 0.08),
  };

  const executiveSummary = stripMd(normalizeParagraphs(
    sectionBetween(md, "## Executive Summary", "## Key Findings"),
  ));
  const keyFindingsRaw = sectionBetween(md, "## Key Findings", "## Detailed Analysis");
  const keyFindings = parseBullets(keyFindingsRaw).map(splitBoldPrefix);
  const detailedRaw = sectionBetween(md, "## Detailed Analysis", "## Areas of Consensus");
  const analyses = parseDetailedAnalysis(detailedRaw).map((a) => ({ title: stripMd(a.title), body: stripMd(a.body) }));
  const consensusRaw = sectionBetween(md, "## Areas of Consensus", "## Areas of Debate");
  const debateRaw = sectionBetween(md, "## Areas of Debate", "## Sources");
  const consensus = parseBullets(consensusRaw).map(stripMd);
  const debate = parseBullets(debateRaw).map(stripMd);
  const sourcesRaw = sectionBetween(md, "## Sources", "## Gaps and Further Research");
  const sources = parseSources(sourcesRaw).map((s) => ({ ...s, title: stripMd(s.title), url: stripMd(s.url) }));
  const gapsRaw = sectionBetween(md, "## Gaps and Further Research", null);
  const gaps = parseBullets(gapsRaw).map(stripMd);

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.author = "Deep Research (Codex)";
  pres.title = title;
  pres.subject = "UK baked beans (Deep Research)";
  pres.theme = { headFontFace: fonts.header, bodyFontFace: fonts.body, lang: "zh-CN" };

  let page = 1;
  const footerLeft = `UK • Baked Beans • Deep Research • ${date}`.trim();

  // Slide 1: Title
  {
    const slide = pres.addSlide();
    addChrome(slide, pres, palette, { dark: true, hideFooter: true, fontBody: fonts.body });
    addTitle(slide, palette, fonts, title.replace(/（Deep Research）/g, ""), `生成日期：${date}  ·  主题：英国罐装烘豆为何成为“日常”`);
  }

  // Slide 2: Executive Summary (2-col)
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body });
    addH1(slide, palette, fonts, "Executive Summary", "一句话：它是“历史 + 经济 + 文化 + 供应链”共同塑造的 comfort food。");

    addCard(slide, pres, palette, { x: MARGIN, y: 1.75, w: 6.3, h: 3.2 }, { shadow: true });
    slide.addText(executiveSummary, {
      x: MARGIN + 0.35,
      y: 1.95,
      w: 5.6,
      h: 2.8,
      fontFace: fonts.body,
      fontSize: 16,
      color: palette.text,
      margin: 0,
      lineSpacingMultiple: 1.1,
    });

    // At a glance
    addCard(slide, pres, palette, { x: 7.2, y: 1.75, w: 2.15, h: 3.2 }, { shadow: true, fill: mix(palette.card, palette.accent1, 0.06) });
    slide.addText("At a glance", {
      x: 7.42,
      y: 1.95,
      w: 1.75,
      h: 0.35,
      fontFace: fonts.header,
      fontSize: 16,
      color: palette.text,
      bold: true,
      margin: 0,
    });

    const tags = [
      { t: "便宜", c: palette.accent1 },
      { t: "耐放", c: palette.accent2 },
      { t: "顶饱", c: palette.accent1 },
      { t: "快手", c: palette.accent2 },
      { t: "文化绑定", c: palette.accent1 },
    ];
    let y = 2.38;
    for (const tag of tags) {
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: 7.42,
        y,
        w: 1.75,
        h: 0.42,
        fill: { color: mix(tag.c, "FFFFFF", 0.45) },
        line: { color: mix(tag.c, "FFFFFF", 0.10), width: 1 },
      });
      slide.addText(tag.t, {
        x: 7.42,
        y: y + 0.08,
        w: 1.75,
        h: 0.3,
        fontFace: fonts.body,
        fontSize: 13,
        align: "center",
        color: palette.text,
        margin: 0,
      });
      y += 0.55;
    }
  }

  // Slide 3: Key Findings (4 cards)
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body });
    addH1(slide, palette, fonts, "Key Findings", "四个“为什么”：路径依赖、约束环境、商业现实、文化仪式。");

    const grid = [
      { x: MARGIN, y: 1.75 },
      { x: 5.35, y: 1.75 },
      { x: MARGIN, y: 3.55 },
      { x: 5.35, y: 3.55 },
    ];

    for (let i = 0; i < Math.min(4, keyFindings.length); i++) {
      const item = keyFindings[i];
      const pos = grid[i];
      addCard(slide, pres, palette, { x: pos.x, y: pos.y, w: 4.0, h: 1.55 }, { shadow: true });

      slide.addShape(pres.shapes.OVAL, {
        x: pos.x + 0.25,
        y: pos.y + 0.28,
        w: 0.55,
        h: 0.55,
        fill: { color: i % 2 === 0 ? palette.accent1 : palette.accent2 },
        line: { color: i % 2 === 0 ? palette.accent1 : palette.accent2 },
      });
      slide.addText(String(i + 1), {
        x: pos.x + 0.25,
        y: pos.y + 0.34,
        w: 0.55,
        h: 0.45,
        fontFace: fonts.header,
        fontSize: 18,
        color: palette.bgText,
        align: "center",
        margin: 0,
      });

      slide.addText(item.title || `发现 ${i + 1}`, {
        x: pos.x + 0.92,
        y: pos.y + 0.25,
        w: 2.95,
        h: 0.4,
        fontFace: fonts.header,
        fontSize: 17,
        bold: true,
        color: palette.text,
        margin: 0,
      });
      slide.addText(item.body, {
        x: pos.x + 0.92,
        y: pos.y + 0.68,
        w: 2.95,
        h: 0.95,
        fontFace: fonts.body,
        fontSize: 13,
        color: mix(palette.text, "FFFFFF", 0.20),
        margin: 0,
      });
    }
  }

  // Slide 4: Section divider
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body, dark: true });

    slide.addText("Detailed Analysis", {
      x: 0.55,
      y: 2.05,
      w: SLIDE_W - 1.2,
      h: 0.8,
      fontFace: fonts.header,
      fontSize: 42,
      bold: true,
      color: palette.bgText,
      margin: 0,
    });
    slide.addText("把“爱吃”拆成 5 个机制：进入路径、约束环境、价格战、早餐仪式、口味差异。", {
      x: 0.55,
      y: 2.95,
      w: 8.5,
      h: 0.5,
      fontFace: fonts.body,
      fontSize: 16,
      color: mix(palette.bgText, "000000", 0.05),
      margin: 0,
    });
  }

  // Slides 5-9: 5 analysis points
  const analysisFooters = [
    "Sources: [1] [4]",
    "Sources: [1]",
    "Sources: [3]",
    "Sources: [2]",
    "Sources: (flavor comparison; general reference)",
  ];
  for (let i = 0; i < Math.min(5, analyses.length); i++) {
    const a = analyses[i];
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, {
      pageNumber: page,
      footerLeft,
      fontBody: fonts.body,
    });
    addH1(slide, palette, fonts, a.title, analysisFooters[i]);

    addCard(slide, pres, palette, { x: MARGIN, y: 1.8, w: 6.0, h: 3.25 }, { shadow: true });
    const { intro, bullets } = splitIntroAndBullets(a.body);
    if (bullets.length === 0) {
      slide.addText(intro, {
        x: MARGIN + 0.35,
        y: 2.02,
        w: 5.3,
        h: 2.85,
        fontFace: fonts.body,
        fontSize: 15,
        color: palette.text,
        margin: 0,
        lineSpacingMultiple: 1.12,
      });
    } else {
      slide.addText(intro, {
        x: MARGIN + 0.35,
        y: 2.02,
        w: 5.3,
        h: 1.1,
        fontFace: fonts.body,
        fontSize: 15,
        color: palette.text,
        margin: 0,
        lineSpacingMultiple: 1.12,
      });
      addBullets(
        slide,
        fonts,
        palette,
        bullets.map(stripMd),
        { x: MARGIN + 0.45, y: 3.06, w: 5.1, h: 2.0 },
      );
    }

    // Right-side visual: either timeline/process cards or comparison
    addCard(slide, pres, palette, { x: 6.85, y: 1.8, w: 2.5, h: 3.25 }, { shadow: true, fill: mix(palette.card, palette.accent2, 0.05) });
    const calloutTitle =
      i === 2 ? "函数性消费" : i === 3 ? "早餐仪式" : i === 4 ? "跨文化踩雷" : "关键点";
    slide.addText(calloutTitle, {
      x: 7.05,
      y: 2.02,
      w: 2.1,
      h: 0.4,
      fontFace: fonts.header,
      fontSize: 16,
      bold: true,
      color: palette.text,
      margin: 0,
    });

    const mini =
      i === 0
        ? ["品牌→渠道", "本地化→降价", "从“稀罕”到“日常”"]
        : i === 1
          ? ["耐放", "加热快", "甚至可冷食"]
          : i === 2
            ? ["便宜", "稳定", "顶饱/蛋白"]
            : i === 3
              ? ["Full English", "Beans on toast", "低门槛一餐"]
              : ["英式：番茄底", "更不甜", "常见无肉"];

    let y = 2.55;
    for (let k = 0; k < mini.length; k++) {
      slide.addShape(pres.shapes.OVAL, {
        x: 7.05,
        y: y + 0.05,
        w: 0.16,
        h: 0.16,
        fill: { color: k % 2 === 0 ? palette.accent1 : palette.accent2 },
        line: { color: k % 2 === 0 ? palette.accent1 : palette.accent2 },
      });
      slide.addText(mini[k], {
        x: 7.27,
        y,
        w: 2.0,
        h: 0.3,
        fontFace: fonts.body,
        fontSize: 13,
        color: mix(palette.text, "FFFFFF", 0.15),
        margin: 0,
      });
      y += 0.48;
    }
  }

  // Slide 10: Areas of Consensus
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body });
    addH1(slide, palette, fonts, "Areas of Consensus", "大家基本同意的：便利、供应、价格、文化绑定。");

    addCard(slide, pres, palette, { x: MARGIN, y: 1.75, w: SLIDE_W - 1.35, h: 3.4 }, { shadow: true });
    addBullets(slide, fonts, palette, consensus, { x: MARGIN + 0.45, y: 2.05, w: SLIDE_W - 2.2, h: 2.85 });
  }

  // Slide 11: Areas of Debate
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body });
    addH1(slide, palette, fonts, "Areas of Debate", "仍有争议的：时间线口径、战争影响强度。");

    addCard(slide, pres, palette, { x: MARGIN, y: 1.75, w: SLIDE_W - 1.35, h: 3.4 }, { shadow: true });
    addBullets(slide, fonts, palette, debate, { x: MARGIN + 0.45, y: 2.05, w: SLIDE_W - 2.2, h: 2.85 });
  }

  // Slide 12: Sources
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body });
    addH1(slide, palette, fonts, "Sources", "用于支撑叙事的公开来源（按引用编号）。");

    const y0 = 1.7;
    const rowH = 0.62;
    addCard(slide, pres, palette, { x: MARGIN, y: 1.55, w: SLIDE_W - 1.35, h: 3.65 }, { shadow: true });

    for (let i = 0; i < Math.min(6, sources.length); i++) {
      const s = sources[i];
      const y = y0 + i * rowH;
      slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x: MARGIN + 0.35,
        y: y + 0.04,
        w: 0.42,
        h: 0.42,
        fill: { color: i % 2 === 0 ? palette.accent1 : palette.accent2 },
        line: { color: i % 2 === 0 ? palette.accent1 : palette.accent2 },
      });
      slide.addText(s.id, {
        x: MARGIN + 0.35,
        y: y + 0.12,
        w: 0.42,
        h: 0.3,
        fontFace: fonts.header,
        fontSize: 12,
        color: palette.bgText,
        align: "center",
        margin: 0,
      });
      slide.addText(s.title, {
        x: MARGIN + 0.85,
        y: y,
        w: 7.9,
        h: 0.28,
        fontFace: fonts.body,
        fontSize: 12,
        color: palette.text,
        margin: 0,
      });
      slide.addText(s.url, {
        x: MARGIN + 0.85,
        y: y + 0.27,
        w: 7.9,
        h: 0.25,
        fontFace: fonts.body,
        fontSize: 10,
        color: mix(palette.text, "FFFFFF", 0.35),
        margin: 0,
      });
    }
  }

  // Slide 13: Gaps & Next Steps (dark)
  {
    const slide = pres.addSlide();
    page += 1;
    addChrome(slide, pres, palette, { pageNumber: page, footerLeft, fontBody: fonts.body, dark: true });
    slide.addText("Gaps & Next Steps", {
      x: 0.55,
      y: 0.8,
      w: SLIDE_W - 1.2,
      h: 0.7,
      fontFace: fonts.header,
      fontSize: 38,
      bold: true,
      color: palette.bgText,
      margin: 0,
    });

    addCard(slide, pres, palette, { x: MARGIN, y: 1.7, w: SLIDE_W - 1.35, h: 3.35 }, { shadow: true, fill: mix(palette.dark, "FFFFFF", 0.06), line: mix(palette.bgText, "000000", 0.55) });
    slide.addText("把研究推进到更“硬”的材料：", {
      x: MARGIN + 0.45,
      y: 1.95,
      w: SLIDE_W - 2.2,
      h: 0.35,
      fontFace: fonts.header,
      fontSize: 16,
      bold: true,
      color: palette.bgText,
      margin: 0,
    });

    const steps = gaps.length > 0 ? gaps : ["追到更一手的战时政府档案与食品史研究。", "更系统比较英式与美式配方/广告的时间线与影响强度。"];
    const runs = [];
    for (let i = 0; i < steps.length; i++) {
      runs.push({ text: steps[i], options: { bullet: { type: "number" }, breakLine: i !== steps.length - 1 } });
    }
    slide.addText(runs, {
      x: MARGIN + 0.45,
      y: 2.35,
      w: SLIDE_W - 2.2,
      h: 2.3,
      fontFace: fonts.body,
      fontSize: 16,
      color: mix(palette.bgText, "000000", 0.02),
      margin: 0,
      paraSpaceAfter: 10,
    });

    slide.addText(`（主题：${theme.name} / 来自 theme-factory）`, {
      x: 0.55,
      y: SLIDE_H - 0.55,
      w: SLIDE_W - 1.2,
      h: 0.3,
      fontFace: fonts.body,
      fontSize: 10,
      color: mix(palette.bgText, "000000", 0.12),
      margin: 0,
    });
  }

  return pres.writeFile({ fileName: outPath });
}

async function main() {
  const mdPath = path.join(process.cwd(), "UK-Baked-Beans-Deep-Research.md");
  const outPath = path.join(process.cwd(), "UK-Baked-Beans-Deep-Research.pptx");
  const args = process.argv.slice(2);
  const themeIdx = args.indexOf("--theme");
  const themeSlug = themeIdx >= 0 && args[themeIdx + 1] ? args[themeIdx + 1] : "golden-hour";

  if (!fs.existsSync(mdPath)) {
    console.error(`找不到输入文件：${mdPath}`);
    process.exit(1);
  }

  await buildDeck(mdPath, outPath, themeSlug);
  console.log(`已生成：${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
