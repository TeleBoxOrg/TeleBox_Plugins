import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { sleep } from "telegram/Helpers";
import { randomInt } from "crypto";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "zhijiao";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
<code>${commandName}</code> 掷筊
`;

type TossResult = "胜" | "阳" | "阴";

const TOSS_OPTIONS: TossResult[] = ["胜", "阳", "阴"];

const TOSS_SYMBOLS: Record<TossResult, string> = {
  胜: "☾☽",
  阳: "☽☽",
  阴: "☾☾",
};

const JIACI_MAP: Record<string, string> = {
  胜胜胜: "胜胜胜：前程皆如意，得意逢贵人，前程去有缘，利名终有望。元亨利贞。",
  胜胜阳: "胜胜阳：千里遇知音，求财自称心，占龙得甘雨，失物眼前寻。上上大吉。",
  胜胜阴: "胜胜阴：明珠失土中，相混土相同，求财应难得，行人信不通。有头无尾。",
  胜阴阳: "胜阴阳：潮生自有时，帆去如得飞，风与周郎便，无云月正辉。三奇吉卦。",
  胜阳胜: "胜阳胜：浩浩长江水，舟帆任往还，问君能遂意，求利有何难。上上大吉。",
  胜阴阴: "胜阴阴：浮云吹散尽，明月正当中，万里一天碧，东西雨便风。求谋如意。",
  胜阴胜: "胜阴胜：曲中应有直，心事忧叹息。云散月重圆，千里风帆急。静待时机。",
  胜阳阳: "胜阳阳：皎皎一轮月，清光四海分，将军巡海岱，群贼望风波。从正则吉。",
  胜阳阴: "胜阳阴：映日隔蛟龙，黑白未分明，什语休凭信，行人正断魂。谋望待时。",
  阳阳阳: "阳阳阳：晚来风飙急，好事在庐江，阻隔成难事，惺惺且暂停。做事平平。",
  阳阳胜: "阳阳胜：玉雀出樊笼，翻翻上碧空，何忧眼前事，财宝自然通。大吉之卦。",
  阳阳阴: "阳阳阴：光辉一处风，恩爱反成仇，闭门且缩头，莫管闲事非。虽吉只迟。",
  阳胜胜: "阳胜胜：东君得好意，枯木发新枝，富贵从人愿，麻衣换绿衣。本原大吉。",
  阳阴阳: "阳阴阳：行船莫恨迟，风急又吹回，举棹应难得，扬帆烟雾中。不利于事。",
  阳胜阳: "阳胜阳：淑女配君子，贤臣遇好君，家和万事顺，国泰万民安。美玉无暇。",
  阳阴阴: "阳阴阴：良骥用把车，轮车力不加，世间无百乐，终老在农家。先凶后吉。",
  阳胜阴: "阳胜阴：阳德方亨日，群阴以待时，小心皆险迹，君子际昌期。君子终吉。",
  阴阴阴: "阴阴阴：六合自然和，求财喜庆多，顺风并顺水，前进莫蹉跎。六合卦也。",
  阴阴胜: "阴阴胜：东风先解冻，花占洛阳春，玉骨冰肌润，青香隔笼间。先难后易。",
  阴阴阳: "阴阴阳：草木枯还发，全凭造化功，莫将求去晚，须借一帆风。向前可为。",
  阴胜胜: "阴胜胜：欲进不能言，进退俱难久，待价与待时，安心俱分守。做事进退。",
  阴胜阴: "阴胜阴：阴阳多反复，做事恐难成，若强求为者，须防来始终。不宜用事。",
  阴阳阳: "阴阳阳：风起三层浪，云生万里阴，交情分彼此，顷刻见灾迍。枉老心力。",
  阴胜阳: "阴胜阳：青云应有路，丹凤羽毛轻，千里人钦仰，提携百事成。亦可用事。",
  阴阳胜: "阴阳胜：飓风未成急，惊危在眼前，忧心非安妥，始终不安然。大而不利。",
  阳阴胜: "阳阴胜：劳碌又劳心，劳心终有成。清风来借力，欢笑见前程。先凶后吉。",
  阴阳阴: "阴阳阴：秋叶无颜色，凋零一夜风。晨鸡醒午梦，心事总成空。梦难成真。",
};

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function pickRandomToss(): TossResult {
  const index = randomInt(TOSS_OPTIONS.length);
  return TOSS_OPTIONS[index];
}

function getInterpretation(text: string): string {
  const positiveKeywords = [
    "大吉",
    "上上",
    "吉",
    "如意",
    "利",
    "顺",
    "亨",
    "昌",
    "喜",
    "圆",
    "安",
  ];
  const cautionKeywords = [
    "凶",
    "危",
    "险",
    "难",
    "阻",
    "忧",
    "恐",
    "不利",
    "暂停",
    "枯",
  ];
  const waitingKeywords = ["待", "守", "缓", "机", "迟", "静"];

  const positiveScore = positiveKeywords.reduce(
    (score, keyword) => (text.includes(keyword) ? score + 1 : score),
    0
  );
  const cautionScore = cautionKeywords.reduce(
    (score, keyword) => (text.includes(keyword) ? score + 1 : score),
    0
  );
  const waitingScore = waitingKeywords.reduce(
    (score, keyword) => (text.includes(keyword) ? score + 1 : score),
    0
  );

  const afterColon = text.split("：")[1] ?? text;
  const firstPhrase = afterColon.split(/，|。/)[0]?.trim() || afterColon.trim();

  const summary = firstPhrase ? `${firstPhrase}。` : "";
  return `${summary}`;
}

function cast(): {
  tosses: TossResult[];
  combination: string;
  jiaci: string;
  interpretation: string;
} {
  const tosses = Array.from({ length: 3 }, () => pickRandomToss());
  const combination = tosses.join("");
  const jiaci = JIACI_MAP[combination] || "未找到对应的卦辞。";
  const interpretation = getInterpretation(jiaci);
  return { tosses, combination, jiaci, interpretation };
}

function formatTossLine(index: number, toss?: TossResult): string {
  if (!toss) {
    return `第${index + 1}投：…`;
  }

  const symbol = TOSS_SYMBOLS[toss];
  return `第${index + 1}投：${toss} ${symbol}`;
}

class ZhijiaoPlugin extends Plugin {
  description: string = `\n掷筊\n强随机 使用 笅杯卦辞廿七句\n${help_text}`;
  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    zhijiao: async (msg: Api.Message, trigger?: Api.Message) => {
      const { tosses, combination, jiaci, interpretation } = cast();

      const buildProgressText = (revealedCount: number) => {
        const progressLines = tosses.map((toss, idx) =>
          idx < revealedCount ? formatTossLine(idx, toss) : formatTossLine(idx)
        );

        const lines = [
          "<b>笅杯</b>",
          // "<code>☾ 表示平面向下，☽ 表示平面向上</code>",
          "",
          "<b>掷筊</b>",
          ...progressLines,
        ];

        return lines.map((line) => (line.length > 0 ? line : "")).join("\n");
      };

      await msg.edit({ text: buildProgressText(0), parseMode: "html" });

      for (let i = 0; i < tosses.length; i++) {
        await sleep(1);
        await msg.edit({
          text: buildProgressText(i + 1),
          parseMode: "html",
        });
      }

      const escapedJiaci = htmlEscape(jiaci);
      const escapedInterpretation = htmlEscape(interpretation);
      const escapedCombination = htmlEscape(combination);
      const tossDetailLines = tosses.map((toss, idx) =>
        formatTossLine(idx, toss)
      );

      const finalLines = [
        "<b>笅杯</b>",
        // "<code>☾ 表示平面向下，☽ 表示平面向上</code>",
        "",
        "<b>掷筊</b>",
        ...tossDetailLines,
        "",
        "<b>卦辞</b>",
        `<blockquote>${escapedJiaci}</blockquote>`,
        // "",
        // "<b>解读</b>",
        // `<blockquote>${escapedInterpretation}</blockquote>`,
        // "",
        // "<b>组合</b>",
        // `<code>${escapedCombination}</code>`,
      ];

      await sleep(0.6);
      await msg.edit({
        text: finalLines
          .map((line) => (line.length > 0 ? line : ""))
          .join("\n"),
        parseMode: "html",
      });
    },
  };
}

export default new ZhijiaoPlugin();
