// Production profiles: one pipeline, many kinds of video. A profile is data, not code — it changes the writer's brief,
// the visual direction, the scene pace, the preferred templates, the default format and the chapter size; every stage
// still runs through the same script → voice → timing → storyboard → render pipeline.
// "short" is the original reel series and adds nothing to the prompts, so existing projects behave exactly as before.

/** Duration categories (seconds). */
export const DURATION_CATEGORIES = [
  { id: 'shorts', name: 'شورتس', min: 10, max: 90 },
  { id: 'short', name: 'فيديو قصير', min: 91, max: 300 },
  { id: 'medium', name: 'فيديو متوسط', min: 301, max: 900 },
  { id: 'long', name: 'فيديو طويل', min: 901, max: 1800 },
];
export const MIN_SECONDS = 10;
export const MAX_SECONDS = 1800;
/** From this length on, the script is planned and written chapter by chapter (and voiced, storyboarded per chapter). */
export const LONGFORM_MIN_SEC = 120;

export const durationCategory = (sec) => (sec === 'auto' ? 'shorts' : (DURATION_CATEGORIES.find((c) => sec <= c.max) || DURATION_CATEGORIES.at(-1)).id);

const P = (o) => ({ writer: '', visual: '', templates: [], chapterSeconds: 180, sceneSeconds: 3.2, skills: [], ...o });

export const PROFILES = {
  short: P({
    name: 'ريل / شورت', en: 'Short-form reel', category: 'short-form', defaultSeconds: 30, platform: 'youtube-shorts',
    description: 'هوك قوي وإيقاع سريع وكابشن كبير، بأسلوب السلسلة (references/script-style.md).',
    skills: ['hooks', 'titles', 'hashtags'],
  }),
  educational: P({
    name: 'تعليمي', en: 'Educational', category: 'education', defaultSeconds: 300, platform: 'youtube',
    description: 'درس خطوة بخطوة: هدف واضح، شرح متدرّج، أمثلة، ومراجعة في آخر كل فصل.',
    writer: 'This is an EDUCATIONAL lesson. Teach step by step: state what the viewer will learn, build from simple to complex, give one concrete example per idea, check understanding with a short question, and end each chapter with a one-line summary. Define every term the first time it appears.',
    visual: 'Clean educational diagrams: steps, labelled parts, comparisons. Prefer templates that SHOW structure (flow, layers, cards, timeline).',
    templates: ['flow', 'layers', 'cards', 'timeline', 'zoom', 'type'], sceneSeconds: 7, chapterSeconds: 180,
    skills: ['claims', 'titles'],
  }),
  documentary: P({
    name: 'وثائقي', en: 'Documentary', category: 'documentary', defaultSeconds: 600, platform: 'youtube',
    description: 'سرد مبني على بحث: سياق، أحداث بالترتيب، شخصيات حقيقية، ومصادر.',
    writer: 'This is a DOCUMENTARY. Narrate calmly and precisely, in chronological or causal order. Give context before events, name real people, places and dates only when you are confident they are correct, and attribute claims ("according to…"). Never invent quotes, numbers or sources. Build tension across chapters and close with significance.',
    visual: 'Documentary look: real photos and footage of places, people and objects; timelines for dates; maps-like layers for context.',
    templates: ['photo', 'timeline', 'type', 'cards', 'chart'], sceneSeconds: 8, chapterSeconds: 200,
    skills: ['claims', 'titles', 'hashtags'],
  }),
  story: P({
    name: 'قصة', en: 'Storytelling', category: 'story', defaultSeconds: 300, platform: 'youtube',
    description: 'قصة بشخصيات وصراع وتحوّل، بداية ووسط ونهاية، وراوي واحد.',
    writer: 'This is a STORY told by one narrator. Introduce a character with a clear want, raise a conflict, escalate it, and resolve it with a change. Keep names, ages, places and objects CONSISTENT across chapters (re-read the outline). Show through concrete actions and senses; short dialogue lines may be quoted inside the narration.',
    visual: 'Story scenes: one moment per scene, consistent characters and settings; animated typography for key lines.',
    templates: ['photo', 'type', 'cards', 'zoom'], sceneSeconds: 6, chapterSeconds: 150,
    skills: ['titles'],
  }),
  cartoon: P({
    name: 'كرتون / أنيميشن', en: 'Cartoon & animation', category: 'animation', defaultSeconds: 180, platform: 'youtube',
    description: 'حكاية بسيطة مرحة للأطفال أو العائلة، بشخصيات ثابتة ومشاهد ملوّنة.',
    writer: 'This is a CARTOON for a young or family audience. Use simple words, a playful tone, repetition and a gentle lesson. Characters keep the same names and traits in every chapter. Avoid anything frightening or unsafe.',
    visual: 'Bright, friendly, iconic illustrations; simple shapes; one clear action per scene.',
    templates: ['cards', 'zoom', 'cycle', 'type', 'flow'], sceneSeconds: 5, chapterSeconds: 120,
    skills: ['titles'],
  }),
  science: P({
    name: 'علمي وتقني', en: 'Science & technology', category: 'science', defaultSeconds: 480, platform: 'youtube',
    description: 'شرح علمي دقيق بمخططات ورسوم بيانية ومصطلحات واضحة.',
    writer: 'This is a SCIENCE / TECHNOLOGY explainer. Be precise: use correct terminology (keep technical terms in English letters), explain mechanisms causally, quantify with honest rounded numbers only when well established, and separate established facts from open questions.',
    visual: 'Technical diagrams and data: processes, layers, macro→micro zooms, charts and gauges for numbers.',
    templates: ['flow', 'zoom', 'chart', 'meter', 'layers', 'cycle'], sceneSeconds: 6, chapterSeconds: 180,
    skills: ['claims', 'titles'],
  }),
  cinematic: P({
    name: 'سينمائي', en: 'Cinematic', category: 'cinematic', defaultSeconds: 240, platform: 'youtube',
    description: 'سرد بصري بإيقاع هادي، صور كاملة الشاشة، انتقالات سينمائية.',
    writer: 'This is a CINEMATIC narration. Fewer, weightier lines; evocative but concrete imagery; rhythm with deliberate pauses (short lines). Let visuals carry the story.',
    visual: 'Full-frame photography and footage, slow fades, minimal on-screen text.',
    templates: ['photo', 'type'], sceneSeconds: 9, chapterSeconds: 180,
    skills: ['titles'],
  }),
  explainer: P({
    name: 'إكسبلينر', en: 'Explainer', category: 'explainer', defaultSeconds: 120, platform: 'youtube',
    description: 'مشكلة ← الفكرة ← إزاي بتشتغل ← الفايدة، بتشبيه واحد واضح.',
    writer: 'This is an EXPLAINER. Structure: the problem, the idea, how it works (one everyday analogy, kept throughout), why it matters. Plain words, no jargon without a definition.',
    visual: 'Motion-graphics explainer: icons, flows, comparisons.',
    templates: ['flow', 'cards', 'zoom', 'cycle', 'type'], sceneSeconds: 5, chapterSeconds: 120,
    skills: ['hooks', 'titles'],
  }),
  promo: P({
    name: 'ترويجي / عرض', en: 'Promotional / presentation', category: 'promo', defaultSeconds: 60, platform: 'youtube',
    description: 'عرض منتج أو فكرة: القيمة، المميزات، الدليل، ودعوة لفعل.',
    writer: 'This is a PROMOTIONAL / PRESENTATION video. Lead with the value to the viewer, list 3 concrete benefits, give proof only if it is provided in the topic (never invent statistics, customers or testimonials), and close with one clear call to action.',
    visual: 'Polished presentation: big typography, benefit cards, product photos.',
    templates: ['type', 'cards', 'photo', 'meter'], sceneSeconds: 4, chapterSeconds: 90,
    skills: ['hooks', 'titles', 'hashtags'],
  }),
};
export const PROFILE_IDS = Object.keys(PROFILES);
export const profileOf = (id) => PROFILES[id] || PROFILES.short;

/** Public description of the profiles for the UI. */
export function publicProfiles() {
  return {
    profiles: Object.fromEntries(Object.entries(PROFILES).map(([id, p]) => [id, {
      name: p.name, en: p.en, category: p.category, description: p.description, defaultSeconds: p.defaultSeconds, platform: p.platform,
      templates: p.templates, sceneSeconds: p.sceneSeconds, chapterSeconds: p.chapterSeconds, skills: p.skills,
    }])),
    categories: DURATION_CATEGORIES, min: MIN_SECONDS, max: MAX_SECONDS, longformFrom: LONGFORM_MIN_SEC,
  };
}
