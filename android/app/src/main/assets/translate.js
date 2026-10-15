/**
 * Lyric letter conversion & romanization engine for LyricWave.
 *
 * Converts non-Latin scripts (Cyrillic: Russian, Ukrainian, Kazakh, etc.,
 * Chinese Hanzi/Pinyin, Japanese Kana/Kanji, Korean Hangul, Devanagari/Hindi,
 * Arabic/Persian/Urdu, Hebrew, Thai, Greek, Georgian, Armenian, Bengali,
 * Punjabi/Gurmukhi, Tamil, Telugu) into Latin/English letters so listeners
 * can read and sing along to the original words phonetically.
 *
 * - 100% client-side, zero latency, runs offline, no external API keys or rate limits.
 * - Detects script & language automatically (prioritizing Russian, Ukrainian, Kazakh).
 * - Leaves pure Latin/English lyrics untouched (no redundant duplicate lines).
 */

export const ROMANIZE_MODES = [
  ['auto', 'Auto-detect (All Non-Latin Scripts)'],
  ['ru', 'Russian (Русский → Latin)'],
  ['uk', 'Ukrainian (Українська → Latin)'],
  ['kk', 'Kazakh (Қазақша → Latin)'],
  ['cyrillic', 'All Cyrillic (RU, UK, KZ, BE, BG, SR, etc.)'],
  ['zh', 'Chinese (中文 → Pinyin)'],
  ['ja', 'Japanese (日本語 → Romaji)'],
  ['ko', 'Korean (한국어 → Romaja)'],
  ['hi', 'Hindi / Devanagari (हिन्दी → Latin)'],
  ['ar', 'Arabic & Persian (العربية / فارسی → Latin)'],
  ['he', 'Hebrew (עברית → Latin)'],
  ['th', 'Thai (ภาษาไทย → Latin)'],
  ['el', 'Greek (Ελληνικά → Latin)'],
  ['ka', 'Georgian (ქართული → Latin)'],
  ['hy', 'Armenian (Հայերեն → Latin)'],
  ['bn', 'Bengali (বাংলা → Latin)'],
  ['pa', 'Punjabi / Gurmukhi (ਪੰਜਾਬੀ → Latin)'],
  ['ta', 'Tamil (தமிழ் → Latin)'],
  ['te', 'Telugu (తెలుగు → Latin)']
];

// Backwards-compatible alias for app.js settings dropdown
export const TRANSLATE_LANGUAGES = ROMANIZE_MODES;

export function defaultTargetLang() {
  return 'auto';
}

export class TranslationQuotaError extends Error {}

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when a line carries no letters (music notes ♪, punctuation, whitespace, numbers). */
export function isUntranslatable(text) {
  return !/\p{L}/u.test(String(text || ''));
}

/** Unique non-empty lines in first-seen order. */
export function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const text = String(raw || '').trim();
    if (!text || isUntranslatable(text) || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Returns true if the romanized line is distinct from the original and worth showing. */
export function isUsefulTranslation(original, romanized) {
  if (!romanized) return false;
  return normalize(original) !== normalize(romanized);
}

// ============================================================================
// 1. Cyrillic Romanization (Russian, Ukrainian, Kazakh, Belarusian, Serbian, etc.)
// ============================================================================

const CYRILLIC_BASE = {
  'а': 'a', 'б': 'b', 'в': 'v', 'д': 'd', 'ж': 'zh', 'з': 'z',
  'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
  'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': "'",
  'ы': 'y', 'ь': "'", 'э': 'e', 'ю': 'yu', 'я': 'ya', 'ё': 'yo',
  // Belarusian, Serbian, Macedonian
  'ў': 'w', 'ј': 'j', 'љ': 'lj', 'њ': 'nj', 'ћ': 'c', 'ђ': 'dj', 'џ': 'dz'
};

const UKRAINIAN_EXTRA = {
  'г': 'h', 'ґ': 'g', 'е': 'e', 'є': 'ye', 'и': 'y', 'і': 'i', 'ї': 'yi'
};

const KAZAKH_EXTRA = {
  'ә': 'ä', 'ғ': 'ğ', 'қ': 'q', 'ң': 'ñ', 'ө': 'ö', 'ұ': 'u',
  'ү': 'ü', 'һ': 'h', 'і': 'i'
};

/** Detects whether Cyrillic text is Kazakh, Ukrainian, or Russian/General. */
export function detectCyrillicLang(text) {
  const str = String(text || '');
  if (/[әғқңөұүһӘҒҚҢӨҰҮҺ]/i.test(str)) return 'kk';
  if (/[єїґЄЇҐ]/i.test(str) || /[бвгґджзклмнпрстфхцчшщ][\'\’][яюєї]/i.test(str)) return 'uk';
  if (/[іїІЇ]/.test(str)) return 'uk';
  return 'ru';
}

/** Romanizes a single line containing Cyrillic characters. */
export function romanizeCyrillic(line, lang = 'auto') {
  if (!/[\u0400-\u04FF]/.test(line)) return line;
  const effectiveLang = (lang === 'auto' || lang === 'cyrillic') ? detectCyrillicLang(line) : lang;

  let result = '';
  const chars = Array.from(line);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const lower = ch.toLowerCase();
    const isUpper = ch !== lower;
    const rawPrev = i > 0 ? chars[i - 1] : ' ';
    const prevLower = rawPrev.toLowerCase();
    const rawNext = i < chars.length - 1 ? chars[i + 1] : ' ';
    const isNextUpper = rawNext !== rawNext.toLowerCase() && rawNext.toLowerCase() !== rawNext.toUpperCase();
    const isPrevUpper = rawPrev !== rawPrev.toLowerCase() && rawPrev.toLowerCase() !== rawPrev.toUpperCase();

    let mapped = null;

    if (effectiveLang === 'uk') {
      if (lower in UKRAINIAN_EXTRA) {
        if (lower === 'є' && !/[\s\p{P}\p{S}]/u.test(prevLower) && !/[аеєиіїоуюя\u044A\u044C]/i.test(prevLower)) {
          mapped = 'ie';
        } else if (lower === 'ї') {
          mapped = (prevLower === 'и' || prevLower === 'y') ? 'i' : 'yi';
        } else {
          mapped = UKRAINIAN_EXTRA[lower];
        }
      }
    } else if (effectiveLang === 'kk') {
      if (lower in KAZAKH_EXTRA) {
        mapped = KAZAKH_EXTRA[lower];
      }
    }

    if (!mapped) {
      if (lower === 'е') {
        if (effectiveLang === 'ru') {
          const isWordStart = i === 0 || /[\s\p{P}\p{S}]/u.test(prevLower);
          const afterVowelOrSign = /[аеёиоуыэюяъь]/i.test(prevLower);
          mapped = (isWordStart || afterVowelOrSign) ? 'ye' : 'e';
        } else {
          mapped = 'e';
        }
      } else if (lower === 'г') {
        mapped = effectiveLang === 'uk' ? 'h' : 'g';
      } else if (lower === 'и') {
        mapped = effectiveLang === 'uk' ? 'y' : 'i';
      } else if (lower in CYRILLIC_BASE) {
        mapped = CYRILLIC_BASE[lower];
      }
    }

    if (mapped !== null) {
      if (isUpper) {
        if (mapped.length > 1 && (isNextUpper || isPrevUpper)) {
          result += mapped.toUpperCase();
        } else {
          result += mapped.charAt(0).toUpperCase() + mapped.slice(1);
        }
      } else {
        result += mapped;
      }
    } else {
      result += ch;
    }
  }

  return result;
}

// ============================================================================
// 2. Korean Hangul Romanization (Revised Romanization of Korean)
// ============================================================================

const HANGUL_L = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_V = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const HANGUL_T = ['', 'k', 'kk', 'ks', 'n', 'nj', 'nh', 't', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'p', 'ps', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];

export function romanizeHangul(text) {
  return Array.from(String(text || '')).map((ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const idx = code - 0xAC00;
      const l = Math.floor(idx / 588);
      const v = Math.floor((idx % 588) / 28);
      const t = idx % 28;
      return HANGUL_L[l] + HANGUL_V[v] + HANGUL_T[t];
    }
    return ch;
  }).join('');
}

// ============================================================================
// 3. Japanese Kana & Kanji Romanization (Hepburn)
// ============================================================================

const HIRAGANA_MAP = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'を': 'o', 'ん': 'n',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'де': 'de', 'ど': 'do',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo',
  'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho',
  'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho',
  'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo',
  'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo',
  'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo',
  'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo',
  'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo',
  'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo',
  'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo',
  'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo'
};

const JAPANESE_KANJI = {
  '愛': 'ai', '私': 'watashi', '僕': 'boku', '君': 'kimi', '心': 'kokoro',
  '夢': 'yume', '涙': 'namida', '夜': 'yoru', '空': 'sora', '花': 'hana',
  '風': 'kaze', '歌': 'uta', '声': 'koe', '今': 'ima', '時': 'toki',
  '世界': 'sekai', '一人': 'hitori', '二人': 'futari', '恋': 'koi',
  '雨': 'ame', '光': 'hikari', '道': 'michi', '星': 'hoshi', '海': 'umi'
};

function toHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));
}

export function romanizeKana(text) {
  let str = String(text || '');
  for (const [kanji, rom] of Object.entries(JAPANESE_KANJI)) {
    str = str.replaceAll(kanji, rom + ' ');
  }

  let hira = toHiragana(str);
  let out = '';
  for (let i = 0; i < hira.length; i++) {
    const pair = hira.slice(i, i + 2);
    if (HIRAGANA_MAP[pair]) {
      out += HIRAGANA_MAP[pair];
      i++;
      continue;
    }
    const ch = hira[i];
    if (ch === 'っ') {
      const next = hira[i + 1] ? (HIRAGANA_MAP[hira.slice(i + 1, i + 3)] || HIRAGANA_MAP[hira[i + 1]] || '') : '';
      out += next.charAt(0) || 't';
      continue;
    }
    if (ch === 'ー') {
      const last = out.charAt(out.length - 1);
      out += /[aeiou]/.test(last) ? last : '-';
      continue;
    }
    out += HIRAGANA_MAP[ch] || ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// 4. Chinese Hanzi Romanization (Mandarin Pinyin)
// ============================================================================

const PINYIN_BUCKETS = {
  'wo': '我握窝喔卧沃', 'ni': '你泥拟逆匿妮腻', 'ta': '他她它踏塔蹋',
  'de': '的地得德', 'shi': '是时不市十事使世式士视试师失识施适实示',
  'zai': '在再载灾仔栽', 'you': '有又由油游友右优幼忧尤',
  'ren': '人任认刃忍仁', 'xin': '心信新辛薪馨寻',
  'ai': '爱哀艾碍埃癌', 'qing': '情请轻清青顷卿晴倾',
  'le': '了乐勒肋', 'bu': '不步部布捕补埔', 'yi': '一以已意易衣依疑移医艺宜仪忆',
  'men': '们门闷扪', 'xiang': '想想向象相响祥降香享', 'hui': '会回灰挥辉悔毁慧汇惠',
  'tian': '天地添填恬', 'ye': '夜也野业页叶爷液', 'meng': '梦猛蒙盟萌',
  'lei': '泪类累雷勒', 'ge': '歌个各格割阁隔', 'ting': '听停庭廷厅挺亭',
  'zou': '走奏揍', 'wang': '忘望往王亡网', 'dao': '到道倒刀导岛盗',
  'shuo': '说说硕朔', 'yao': '要摇咬药耀遥腰邀', 'qu': '去曲取区屈趋驱',
  'lai': '来赖莱', 'hao': '好号浩豪毫壕皓', 'mei': '没美每妹魅枚梅霉煤',
  'hen': '很恨狠', 'dou': '都斗豆抖兜陡', 'ba': '把吧拔爸霸八',
  'zhong': '中国重中众种终钟衷', 'guo': '国过果锅裹郭',
  'sheng': '声生升胜圣剩省盛绳', 'feng': '风丰封锋峰蜂逢疯',
  'yu': '雨与于鱼余羽语遇欲预宇域玉育誉', 'yun': '云运允匀陨',
  'guang': '光广逛', 'xiao': '笑小效销消宵晓肖啸萧',
  'ku': '哭苦枯裤窟', 'shui': '谁水税睡', 'jian': '见间建减简剑渐健件鉴',
  'zhi': '知只之指直至制治志致质支枝值', 'fen': '分份纷奋粉愤',
  'bian': '变边便编辩偏贬', 'nan': '难南男喃楠', 'nv': '女',
  'kuai': '快块筷', 'man': '慢满漫曼蛮', 'tong': '痛同通统童桐铜',
  'shang': '伤上赏尚商殇', 'hai': '海孩害海骇', 'xue': '雪学血靴穴',
  'hua': '花话化华画滑', 'chun': '春纯唇蠢', 'qiu': '秋求球仇囚',
  'dong': '冬东懂动洞冻栋', 'xia': '夏下吓狭峡霞辖', 'zhe': '这着者遮折',
  'na': '那拿哪呐', 'zen': '怎', 'yang': '样阳羊扬杨养洋氧',
  'shen': '什么神深身沉伸', 'me': '么么麽', 'jiu': '就九酒久旧救究',
  'he': '和何合喝盒河荷核', 'kan': '看看刊勘', 'gei': '给',
  'dan': '但单蛋胆担淡弹', 'que': '却缺雀确', 'yin': '因为音引银印阴隐',
  'wei': '为位未微威唯维伟卫尾', 'suo': '所索锁缩', 'zhen': '真镇阵针震振枕',
  'jia': '家假加价甲架驾佳', 'deng': '等待灯登邓澄', 'zhao': '找照朝召爪罩',
  'bie': '别', 'si': '死四思似司斯私丝', 'yan': '眼睛言颜烟演宴岩盐',
  'jing': '静睛景境经精惊警京', 'jie': '界借结街节接解洁', 'xing': '星星行醒形姓性',
  'ri': '日月日', 'yue': '月越约悦跃乐', 'nian': '年念粘碾',
  'dian': '点电店典殿垫颠', 'shou': '手收首守受瘦兽'
};

const CHAR_TO_PINYIN = new Map();
for (const [syllable, chars] of Object.entries(PINYIN_BUCKETS)) {
  for (const ch of chars) CHAR_TO_PINYIN.set(ch, syllable);
}

export function romanizeChinese(text) {
  let out = [];
  for (const ch of Array.from(String(text || ''))) {
    if (CHAR_TO_PINYIN.has(ch)) {
      out.push(CHAR_TO_PINYIN.get(ch));
    } else {
      out.push(ch);
    }
  }
  return out.join(' ').replace(/\s+([,.:;!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

// ============================================================================
// 5. Devanagari Romanization (Hindi, Marathi, Sanskrit, Nepali)
// ============================================================================

const DEVA_VOWELS = {
  '\u0905': 'a', '\u0906': 'aa', '\u0907': 'i', '\u0908': 'ee', '\u0909': 'u', '\u090A': 'oo',
  '\u090B': 'ri', '\u090F': 'e', '\u0910': 'ai', '\u0913': 'o', '\u0914': 'au'
};
const DEVA_MATRAS = {
  '\u093E': 'aa', '\u093F': 'i', '\u0940': 'ee', '\u0941': 'u', '\u0942': 'oo',
  '\u0943': 'ri', '\u0947': 'e', '\u0948': 'ai', '\u094B': 'o', '\u094C': 'au'
};
const DEVA_CONSONANTS = {
  '\u0915': 'k', '\u0916': 'kh', '\u0917': 'g', '\u0918': 'gh', '\u0919': 'ng',
  '\u091A': 'ch', '\u091B': 'chh', '\u091C': 'j', '\u091D': 'jh', '\u091E': 'ny',
  '\u091F': 't', '\u0920': 'th', '\u0921': 'd', '\u0922': 'dh', '\u0923': 'n',
  '\u0924': 't', '\u0925': 'th', '\u0926': 'd', '\u0927': 'dh', '\u0928': 'n',
  '\u092A': 'p', '\u092B': 'ph', '\u092C': 'b', '\u092D': 'bh', '\u092E': 'm',
  '\u092F': 'y', '\u0930': 'r', '\u0932': 'l', '\u0935': 'v',
  '\u0936': 'sh', '\u0937': 'sh', '\u0938': 's', '\u0939': 'h',
  '\u0958': 'q', '\u0959': 'kh', '\u095A': 'gh', '\u095B': 'z', '\u095C': 'r', '\u095D': 'rh', '\u095E': 'f'
};

export function romanizeDevanagari(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1] || '';
    if (DEVA_VOWELS[c]) { out += DEVA_VOWELS[c]; continue; }
    if (DEVA_CONSONANTS[c]) {
      const base = DEVA_CONSONANTS[c];
      if (next === '\u094D') { out += base; i++; } // halant suppresses inherent 'a'
      else if (DEVA_MATRAS[next]) { out += base + DEVA_MATRAS[next]; i++; }
      else if (next === '' || /[\s\p{P}]/u.test(next)) { out += base; } // word-final schwa deletion
      else { out += base + 'a'; }
      continue;
    }
    if (c === '\u0902' || c === '\u0901') { out += 'n'; continue; }
    if (c === '\u0903') { out += 'h'; continue; }
    out += c;
  }
  return out;
}

// ============================================================================
// 6. Arabic Script Romanization (Arabic, Persian/Farsi, Urdu)
// ============================================================================

const ARABIC_CONSONANTS = new Set(['b','t','th','j','h','kh','d','dh','r','z','s','sh','d','t','z','\'','gh','f','q','k','l','m','n','h','p','ch','zh','g']);
const ARABIC_BASE = {
  '\u0627': 'a', '\u0628': 'b', '\u062A': 't', '\u062B': 'th', '\u062C': 'j', '\u062D': 'h',
  '\u062E': 'kh', '\u062F': 'd', '\u0630': 'dh', '\u0631': 'r', '\u0632': 'z', '\u0633': 's',
  '\u0634': 'sh', '\u0635': 's', '\u0636': 'd', '\u0637': 't', '\u0638': 'z', '\u0639': '\'',
  '\u063A': 'gh', '\u0641': 'f', '\u0642': 'q', '\u0643': 'k', '\u0644': 'l', '\u0645': 'm',
  '\u0646': 'n', '\u0647': 'h', '\u0649': 'a', '\u0629': 'h',
  '\u0621': '\'', '\u0626': '\'', '\u0624': '\'', '\u0622': 'aa', '\u0623': 'a', '\u0625': 'i',
  '\u067E': 'p', '\u0686': 'ch', '\u0698': 'zh', '\u06AF': 'g', '\u06A9': 'k',
  '\u06D2': 'e', '\u0679': 't', '\u0688': 'd', '\u0691': 'r'
};

export function romanizeArabic(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = out.slice(-1).toLowerCase();
    if (c === '\u064A' || c === '\u06CC') {
      out += (ARABIC_CONSONANTS.has(prev) ? 'i' : 'y');
    } else if (c === '\u0648') {
      out += (ARABIC_CONSONANTS.has(prev) ? 'u' : 'w');
    } else {
      out += ARABIC_BASE[c] || c;
    }
  }
  return out;
}

// ============================================================================
// 7. Hebrew Romanization
// ============================================================================

const HEBREW_MAP = {
  '\u05D0': '', '\u05D1': 'v', '\u05D2': 'g', '\u05D3': 'd', '\u05D4': 'h',
  '\u05D5': 'o', '\u05D6': 'z', '\u05D7': 'ch', '\u05D8': 't', '\u05D9': 'i',
  '\u05DA': 'kh', '\u05DB': 'k', '\u05DC': 'l', '\u05DD': 'm', '\u05DE': 'm',
  '\u05DF': 'n', '\u05E0': 'n', '\u05E1': 's', '\u05E2': '', '\u05E3': 'f',
  '\u05E4': 'p', '\u05E5': 'ts', '\u05E6': 'ts', '\u05E7': 'k', '\u05E8': 'r',
  '\u05E9': 'sh', '\u05EA': 't'
};

export function romanizeHebrew(text) {
  return Array.from(String(text || '')).map((c) => HEBREW_MAP[c] !== undefined ? HEBREW_MAP[c] : c).join('');
}

// ============================================================================
// 8. Thai Romanization (Royal Thai General System)
// ============================================================================

const THAI_MAP = {
  'ก': 'k', 'ข': 'kh', 'ฃ': 'kh', 'ค': 'kh', 'ฅ': 'kh', 'ฆ': 'kh', 'ง': 'ng',
  'จ': 'ch', 'ฉ': 'ch', 'ช': 'ch', 'ซ': 's', 'ฌ': 'ch', 'ญ': 'y', 'ฎ': 'd',
  'ฏ': 't', 'ฐ': 'th', 'ฑ': 'th', 'ฒ': 'th', 'ณ': 'n', 'ด': 'd', 'ต': 't',
  'ถ': 'th', 'ท': 'th', 'ธ': 'th', 'น': 'n', 'บ': 'b', 'ป': 'p', 'ผ': 'ph',
  'ฝ': 'f', 'พ': 'ph', 'ฟ': 'f', 'ภ': 'ph', 'ม': 'm', 'ย': 'y', 'ร': 'r',
  'ฤ': 'rue', 'ล': 'l', 'ว': 'w', 'ศ': 's', 'ษ': 's', 'ส': 's', 'ห': 'h',
  'ฬ': 'l', 'อ': '', 'ฮ': 'h',
  'ะ': 'a', 'ั': 'a', 'า': 'aa', 'ำ': 'am', 'ิ': 'i', 'ี': 'ee', 'ึ': 'ue',
  'ื': 'ue', 'ุ': 'u', 'ู': 'oo', 'เ': 'e', 'แ': 'ae', 'โ': 'o', 'ใ': 'ai', 'ไ': 'ai'
};

export function romanizeThai(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/[\u0E48-\u0E4C\u0E47\u0E4E\u0E4F]/.test(c)) continue; // ignore silent tone marks
    if (['เ', 'แ', 'โ', 'ใ', 'ไ'].includes(c) && i < chars.length - 1) {
      const nextConsonant = THAI_MAP[chars[i + 1]] || chars[i + 1];
      out += nextConsonant + (THAI_MAP[c] || c);
      i++;
      continue;
    }
    out += THAI_MAP[c] !== undefined ? THAI_MAP[c] : c;
  }
  return out;
}

// ============================================================================
// 9. Greek Romanization
// ============================================================================

const GREEK_MAP = {
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z',
  'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm',
  'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's',
  'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o',
  'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o', 'ύ': 'y', 'ώ': 'o'
};

export function romanizeGreek(text) {
  return Array.from(String(text || '')).map((ch) => {
    const lower = ch.toLowerCase();
    const mapped = GREEK_MAP[lower];
    if (!mapped) return ch;
    if (ch !== lower) {
      return mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
    return mapped;
  }).join('');
}

// ============================================================================
// 10. Georgian & Armenian Romanization
// ============================================================================

const GEORGIAN_MAP = {
  'ა':'a','ბ':'b','გ':'g','დ':'d','ე':'e','ვ':'v','ზ':'z','თ':'t','ი':'i','კ':'k',
  'ლ':'l','მ':'m','ნ':'n','ო':'o','პ':'p','ჟ':'zh','რ':'r','ს':'s','ტ':'t','უ':'u',
  'ფ':'p','ქ':'k','ღ':'gh','ყ':'q','შ':'sh','ჩ':'ch','ც':'ts','ძ':'dz','წ':'ts','ჭ':'ch',
  'ხ':'kh','ჯ':'j','ჰ':'h'
};

export function romanizeGeorgian(text) {
  return Array.from(String(text || '')).map((c) => GEORGIAN_MAP[c] || c).join('');
}

const ARMENIAN_MAP = {
  'ա':'a','բ':'b','գ':'g','դ':'d','ե':'e','զ':'z','է':'e','ը':'y','թ':'t','ժ':'zh',
  'ի':'i','լ':'l','խ':'kh','ծ':'ts','կ':'k','հ':'h','ձ':'dz','ղ':'gh','ճ':'ch','մ':'m',
  'յ':'y','ն':'n','շ':'sh','ո':'o','չ':'ch','պ':'p','ջ':'j','ռ':'r','ս':'s','վ':'v',
  'տ':'t','ր':'r','ց':'ts','ւ':'v','փ':'p','ք':'k','և':'ev','օ':'o','ֆ':'f'
};

export function romanizeArmenian(text) {
  return Array.from(String(text || '')).map((c) => {
    const l = c.toLowerCase();
    const m = ARMENIAN_MAP[l];
    if (!m) return c;
    return c !== l ? (m.charAt(0).toUpperCase() + m.slice(1)) : m;
  }).join('');
}

// ============================================================================
// 11. Bengali, Punjabi (Gurmukhi), Tamil, Telugu Romanization
// ============================================================================

const BN_V = {'\u0985':'o','\u0986':'a','\u0987':'i','\u0988':'ee','\u0989':'u','\u098A':'oo','\u098F':'e','\u0990':'oi','\u0993':'o','\u0994':'ou'};
const BN_M = {'\u09BE':'a','\u09BF':'i','\u09C0':'ee','\u09C1':'u','\u09C2':'oo','\u09C7':'e','\u09C8':'oi','\u09CB':'o','\u09CC':'ou'};
const BN_C = {'\u0995':'k','\u0996':'kh','\u0997':'g','\u0998':'gh','\u0999':'ng','\u099A':'ch','\u099B':'chh','\u099C':'j','\u099D':'jh','\u099E':'ny','\u099F':'t','\u09A0':'th','\u09A1':'d','\u09A2':'dh','\u09A3':'n','\u09A4':'t','\u09A5':'th','\u09A6':'d','\u09A7':'dh','\u09A8':'n','\u09AA':'p','\u09AB':'f','\u09AC':'b','\u09AD':'bh','\u09AE':'m','\u09AF':'j','\u09B0':'r','\u09B2':'l','\u09B6':'sh','\u09B7':'sh','\u09B8':'sh','\u09B9':'h','\u09DC':'r','\u09DD':'rh','\u09DF':'y'};

export function romanizeBengali(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], next = chars[i + 1] || '';
    if (BN_V[c]) { out += BN_V[c]; continue; }
    if (BN_C[c]) {
      const b = BN_C[c];
      if (next === '\u09CD') { out += b; i++; }
      else if (BN_M[next]) { out += b + BN_M[next]; i++; }
      else if (next === '' || /[\s\p{P}]/u.test(next)) { out += b; }
      else { out += b + 'o'; }
      continue;
    }
    if (c === '\u0982') { out += 'ng'; continue; }
    out += c;
  }
  return out;
}

const PA_V = {'\u0A05':'a','\u0A06':'aa','\u0A07':'i','\u0A08':'ee','\u0A09':'u','\u0A0A':'oo','\u0A0F':'e','\u0A10':'ai','\u0A13':'o','\u0A14':'au'};
const PA_M = {'\u0A3E':'aa','\u0A3F':'i','\u0A40':'ee','\u0A41':'u','\u0A42':'oo','\u0A47':'e','\u0A48':'ai','\u0A4B':'o','\u0A4C':'au'};
const PA_C = {'\u0A15':'k','\u0A16':'kh','\u0A17':'g','\u0A18':'gh','\u0A19':'ng','\u0A1A':'ch','\u0A1B':'chh','\u0A1C':'j','\u0A1D':'jh','\u0A1E':'ny','\u0A1F':'t','\u0A20':'th','\u0A21':'d','\u0A22':'dh','\u0A23':'n','\u0A24':'t','\u0A25':'th','\u0A26':'d','\u0A27':'dh','\u0A28':'n','\u0A2A':'p','\u0A2B':'ph','\u0A2C':'b','\u0A2D':'bh','\u0A2E':'m','\u0A2F':'y','\u0A30':'r','\u0A32':'l','\u0A35':'v','\u0A38':'s','\u0A39':'h'};

export function romanizeGurmukhi(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], next = chars[i + 1] || '';
    if (PA_V[c]) { out += PA_V[c]; continue; }
    if (PA_C[c]) {
      const b = PA_C[c];
      if (next === '\u0A4D') { out += b; i++; }
      else if (PA_M[next]) { out += b + PA_M[next]; i++; }
      else if (next === '' || /[\s\p{P}]/u.test(next)) { out += b; }
      else { out += b + 'a'; }
      continue;
    }
    if (c === '\u0A02') { out += 'n'; continue; }
    out += c;
  }
  return out;
}

const TA_V = {'\u0B85':'a','\u0B86':'aa','\u0B87':'i','\u0B88':'ee','\u0B89':'u','\u0B8A':'oo','\u0B8E':'e','\u0B8F':'ae','\u0B90':'ai','\u0B92':'o','\u0B93':'oh','\u0B94':'au'};
const TA_M = {'\u0BBE':'aa','\u0BBF':'i','\u0BC0':'ee','\u0BC1':'u','\u0BC2':'oo','\u0BC6':'e','\u0BC7':'ae','\u0BC8':'ai','\u0BCA':'o','\u0BCB':'oh','\u0BCC':'au'};
const TA_C = {'\u0B95':'k','\u0B99':'ng','\u0B9A':'ch','\u0B9C':'j','\u0B9E':'ny','\u0B9F':'t','\u0BA3':'n','\u0BA4':'th','\u0BA8':'n','\u0BA9':'n','\u0BAA':'p','\u0BAE':'m','\u0BAF':'y','\u0BB0':'r','\u0BB1':'r','\u0BB2':'l','\u0BB3':'l','\u0BB4':'zh','\u0BB5':'v','\u0BB6':'sh','\u0BB7':'sh','\u0BB8':'s','\u0BB9':'h'};

export function romanizeTamil(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], next = chars[i + 1] || '';
    if (TA_V[c]) { out += TA_V[c]; continue; }
    if (TA_C[c]) {
      const b = TA_C[c];
      if (next === '\u0BCD') { out += b; i++; }
      else if (TA_M[next]) { out += b + TA_M[next]; i++; }
      else if (next === '' || /[\s\p{P}]/u.test(next)) { out += b; }
      else { out += b + 'a'; }
      continue;
    }
    out += c;
  }
  return out;
}

const TE_V = {'\u0C05':'a','\u0C06':'aa','\u0C07':'i','\u0C08':'ee','\u0C09':'u','\u0C0A':'oo','\u0C0E':'e','\u0C0F':'ae','\u0C10':'ai','\u0C12':'o','\u0C13':'oh','\u0C14':'au'};
const TE_M = {'\u0C3E':'aa','\u0C3F':'i','\u0C40':'ee','\u0C41':'u','\u0C42':'oo','\u0C46':'e','\u0C47':'ae','\u0C48':'ai','\u0C4A':'o','\u0C4B':'oh','\u0C4C':'au'};
const TE_C = {'\u0C15':'k','\u0C16':'kh','\u0C17':'g','\u0C18':'gh','\u0C19':'ng','\u0C1A':'ch','\u0C1B':'chh','\u0C1C':'j','\u0C1D':'jh','\u0C1E':'ny','\u0C1F':'t','\u0C20':'th','\u0C21':'d','\u0C22':'dh','\u0C23':'n','\u0C24':'t','\u0C25':'th','\u0C26':'d','\u0C27':'dh','\u0C28':'n','\u0C2A':'p','\u0C2B':'ph','\u0C2C':'b','\u0C2D':'bh','\u0C2E':'m','\u0C2F':'y','\u0C30':'r','\u0C32':'l','\u0C35':'v','\u0C36':'sh','\u0C37':'sh','\u0C38':'s','\u0C39':'h'};

export function romanizeTelugu(text) {
  let out = '';
  const chars = Array.from(String(text || ''));
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], next = chars[i + 1] || '';
    if (TE_V[c]) { out += TE_V[c]; continue; }
    if (TE_C[c]) {
      const b = TE_C[c];
      if (next === '\u0C4D') { out += b; i++; }
      else if (TE_M[next]) { out += b + TE_M[next]; i++; }
      else if (next === '' || /[\s\p{P}]/u.test(next)) { out += b; }
      else { out += b + 'a'; }
      continue;
    }
    out += c;
  }
  return out;
}

// ============================================================================
// Master Romanization Dispatcher
// ============================================================================

/**
 * Romanize a single lyric line based on mode (auto, ru, uk, kk, cyrillic, zh, ja, ko, hi, ar, he, th, el, ka, hy, bn, pa, ta, te).
 * Returns the converted string in English letters, or empty string '' if no conversion is needed.
 */
export function romanizeLine(text, mode = 'auto') {
  const raw = String(text || '').trim();
  if (!raw || isUntranslatable(raw)) return '';

  let converted = raw;

  if (mode === 'ko' || (mode === 'auto' && /[\uAC00-\uD7AF]/.test(converted))) {
    converted = romanizeHangul(converted);
  }
  if (mode === 'ja' || (mode === 'auto' && /[\u3040-\u309F\u30A0-\u30FF]/.test(converted))) {
    converted = romanizeKana(converted);
  }
  if (mode === 'zh' || (mode === 'auto' && /[\u4E00-\u9FFF]/.test(converted))) {
    converted = romanizeChinese(converted);
  }
  if (mode === 'hi' || (mode === 'auto' && /[\u0900-\u097F]/.test(converted))) {
    converted = romanizeDevanagari(converted);
  }
  if (mode === 'ar' || (mode === 'auto' && /[\u0600-\u06FF\u0750-\u077F]/.test(converted))) {
    converted = romanizeArabic(converted);
  }
  if (mode === 'he' || (mode === 'auto' && /[\u0590-\u05FF]/.test(converted))) {
    converted = romanizeHebrew(converted);
  }
  if (mode === 'th' || (mode === 'auto' && /[\u0E00-\u0E7F]/.test(converted))) {
    converted = romanizeThai(converted);
  }
  if (mode === 'el' || (mode === 'auto' && /[\u0370-\u03FF]/.test(converted))) {
    converted = romanizeGreek(converted);
  }
  if (mode === 'ka' || (mode === 'auto' && /[\u10A0-\u10FF]/.test(converted))) {
    converted = romanizeGeorgian(converted);
  }
  if (mode === 'hy' || (mode === 'auto' && /[\u0530-\u058F]/.test(converted))) {
    converted = romanizeArmenian(converted);
  }
  if (mode === 'bn' || (mode === 'auto' && /[\u0980-\u09FF]/.test(converted))) {
    converted = romanizeBengali(converted);
  }
  if (mode === 'pa' || (mode === 'auto' && /[\u0A00-\u0A7F]/.test(converted))) {
    converted = romanizeGurmukhi(converted);
  }
  if (mode === 'ta' || (mode === 'auto' && /[\u0B80-\u0BFF]/.test(converted))) {
    converted = romanizeTamil(converted);
  }
  if (mode === 'te' || (mode === 'auto' && /[\u0C00-\u0C7F]/.test(converted))) {
    converted = romanizeTelugu(converted);
  }
  if (/[\u0400-\u04FF]/.test(converted)) {
    converted = romanizeCyrillic(converted, mode);
  }

  return isUsefulTranslation(raw, converted) ? converted : '';
}

/**
 * Transliterates an array of lyric lines. Returns an array of identical length,
 * with '' wherever no letter conversion is needed.
 */
export async function translateLines(lines, targetLang = 'auto') {
  if (!Array.isArray(lines)) return [];

  let resolvedMode = targetLang;
  if (targetLang === 'auto' || targetLang === 'cyrillic') {
    const joined = lines.join(' ');
    if (/[әғқңөұүһӘҒҚҢӨҰҮҺ]/i.test(joined)) {
      resolvedMode = 'kk';
    } else if (/[єїґЄЇҐ]/i.test(joined) || /[бвгґджзклмнпрстфхцчшщ][\'\’][яюєї]/i.test(joined)) {
      resolvedMode = 'uk';
    } else if (/[іїІЇ]/.test(joined)) {
      resolvedMode = 'uk';
    } else if (/[\u0400-\u04FF]/.test(joined)) {
      resolvedMode = 'ru';
    }
  }

  const map = new Map();
  for (const raw of uniqueLines(lines)) {
    map.set(raw, romanizeLine(raw, resolvedMode));
  }

  return lines.map((line) => {
    const trimmed = String(line || '').trim();
    return map.get(trimmed) || '';
  });
}

export function linesOf(lyrics) {
  if (!lyrics) return [];
  if (lyrics.status === 'synced') return lyrics.syncedLines.map((l) => l.text || '');
  if (lyrics.status === 'plain') return String(lyrics.plainLyrics || '').split('\n');
  return [];
}

export function translationCacheKey(lyrics, targetLang) {
  const id = lyrics.lrclibId || (lyrics.syncedLines?.[0]?.text || lyrics.plainLyrics || '').slice(0, 80);
  return `${id}__${targetLang}`;
}

/**
 * Convert letters of a fetchLyrics() result. Instant, offline, and non-blocking.
 */
export async function translateLyrics(lyrics, targetLang = 'auto') {
  const lines = linesOf(lyrics);
  if (lines.length === 0) return [];
  return translateLines(lines, targetLang);
}

// Aliases
export const romanizeLyrics = translateLyrics;
export const romanizeLines = translateLines;
