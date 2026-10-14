import { type SafetyCategory } from '@shorts/contracts';

/**
 * Deterministic content rules.
 *
 * These run before — and independently of — any model-based review. A rule layer
 * has properties an LLM reviewer does not: it is free, instant, deterministic,
 * and cannot be talked out of its opinion by the text it is inspecting. The LLM
 * reviewer is a *second* opinion, never the only one.
 *
 * `weight` is the confidence a match contributes. `action` decides what a match
 * means on its own: BLOCK rules are categorical; REVIEW rules flag for a human.
 */

export interface SafetyRule {
  id: string;
  category: SafetyCategory;
  pattern: RegExp;
  action: 'BLOCK' | 'REVIEW';
  weight: number;
  description: string;
  /**
   * Rules that only make sense on some surfaces. A visual prompt mentioning
   * "knife" is worth reviewing; narration about cutting a birthday cake is not
   * the same thing, so surface scoping keeps false positives down.
   */
  surfaces?: string[];
}

/**
 * Word-boundary helper. Written as a function so every rule gets consistent
 * boundaries and none accidentally matches inside an unrelated word
 * (the classic "Scunthorpe" failure).
 */
const words = (...terms: string[]): RegExp =>
  new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'iu');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SAFETY_RULES: readonly SafetyRule[] = Object.freeze([
  // -- Child safety: the strictest category --------------------------------
  {
    id: 'child.sexualisation',
    category: 'CHILD_SAFETY',
    pattern:
      /\b(sexy|seductive|lingerie|bikini|undress|naked|nude|topless|revealing outfit|provocative)\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Sexualised description. Categorically forbidden for any character.',
  },
  {
    id: 'child.real_identification',
    category: 'CHILD_SAFETY',
    pattern:
      /\b(real (child|kid|baby|toddler)|actual (child|kid)|my (son|daughter|nephew|niece)|photo of a (child|kid|baby))\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Reference to a real, identifiable child.',
  },
  {
    id: 'child.unsupervised_danger',
    category: 'CHILD_SAFETY',
    pattern:
      /\b(alone near (a )?(pool|road|traffic|fire)|unattended (baby|toddler|child)|climbs out of the window)\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Child depicted in an unsafe, unsupervised situation.',
  },

  // -- Sexual content -------------------------------------------------------
  {
    id: 'sexual.explicit',
    category: 'SEXUAL',
    pattern: words('porn', 'pornographic', 'explicit sex', 'erotic', 'nsfw', 'fetish', 'orgasm'),
    action: 'BLOCK',
    weight: 1,
    description: 'Sexually explicit content.',
  },

  // -- Violence -------------------------------------------------------------
  {
    id: 'violence.graphic',
    category: 'VIOLENCE',
    pattern: words(
      'gore',
      'decapitate',
      'dismember',
      'mutilate',
      'bloodbath',
      'massacre',
      'torture',
    ),
    action: 'BLOCK',
    weight: 1,
    description: 'Graphic violence.',
  },
  {
    id: 'violence.weapons',
    category: 'VIOLENCE',
    pattern: words(
      'gun',
      'pistol',
      'rifle',
      'shotgun',
      'knife',
      'blade',
      'weapon',
      'stab',
      'shoot',
    ),
    action: 'REVIEW',
    weight: 0.6,
    description: 'Weapon reference — needs a human to judge the context.',
  },

  // -- Self-harm ------------------------------------------------------------
  {
    id: 'self_harm',
    category: 'SELF_HARM',
    pattern: words(
      'suicide',
      'self-harm',
      'self harm',
      'cutting myself',
      'kill myself',
      'overdose',
    ),
    action: 'BLOCK',
    weight: 1,
    description: 'Self-harm content.',
  },

  // -- Dangerous challenges -------------------------------------------------
  {
    id: 'dangerous.challenge',
    category: 'DANGEROUS_CHALLENGE',
    pattern:
      /\b(challenge)\b.{0,40}\b(fire|poison|choking|blackout|swallow|jump|hold your breath)\b|\b(tide pod|blackout challenge|choking game)\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Imitable dangerous challenge.',
  },
  {
    id: 'dangerous.household',
    category: 'DANGEROUS_CHALLENGE',
    pattern: words(
      'bleach',
      'ammonia',
      'gasoline',
      'lighter fluid',
      'electrical outlet',
      'boiling water',
    ),
    action: 'REVIEW',
    weight: 0.5,
    description: 'Household hazard that a child might imitate.',
  },

  // -- Hate -----------------------------------------------------------------
  {
    id: 'hate.slur_context',
    category: 'HATE',
    pattern:
      /\b(racial slur|ethnic slur|hate speech|white supremac(y|ist)|neo-?nazi|ethnic cleansing)\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Hateful content.',
  },

  // -- Illegal activity -----------------------------------------------------
  {
    id: 'illegal.drugs_crime',
    category: 'ILLEGAL_ACTIVITY',
    pattern: words(
      'cocaine',
      'heroin',
      'meth',
      'methamphetamine',
      'how to steal',
      'counterfeit',
      'launder money',
    ),
    action: 'BLOCK',
    weight: 1,
    description: 'Illegal activity.',
  },

  // -- Medical --------------------------------------------------------------
  {
    id: 'medical.advice',
    category: 'MEDICAL_ADVICE',
    pattern:
      /\b(cures?|treats?|heals?)\b.{0,30}\b(cancer|autism|covid|diabetes|depression)\b|\b(dosage|mg of|prescription)\b/iu,
    action: 'REVIEW',
    weight: 0.7,
    description: 'Possible medical claim or dosing advice.',
  },

  // -- Copyright / real people ----------------------------------------
  {
    id: 'copyright.franchise',
    category: 'COPYRIGHT_RISK',
    pattern: words(
      'disney',
      'pixar',
      'marvel',
      'mickey mouse',
      'peppa pig',
      'cocomelon',
      'paw patrol',
      'bluey',
      'pokemon',
      'pokémon',
      'nintendo',
      'mario',
      'spongebob',
      'minions',
      'frozen elsa',
    ),
    action: 'BLOCK',
    weight: 1,
    description: 'Third-party franchise or character.',
  },
  {
    id: 'copyright.reuse_intent',
    category: 'COPYRIGHT_RISK',
    pattern:
      /\b(in the style of|recreate|remake|copy) (this|that|the) (video|short|clip|creator)\b|\breupload\b|\bre-?post (someone|another)\b/iu,
    action: 'BLOCK',
    weight: 1,
    description: 'Intent to reproduce someone else’s content.',
  },
  {
    id: 'copyright.music',
    category: 'COPYRIGHT_RISK',
    pattern: /\b(popular song|chart hit|billboard|top 40|licensed track|famous soundtrack)\b/iu,
    action: 'REVIEW',
    weight: 0.6,
    description: 'Possible use of music we may not have rights to.',
  },
  {
    id: 'real_person',
    category: 'REAL_PERSON',
    pattern: /\b(celebrity|famous actor|the president|prime minister|deepfake|lookalike of)\b/iu,
    action: 'REVIEW',
    weight: 0.7,
    description: 'Possible depiction of a real person.',
  },

  // -- Profanity ------------------------------------------------------------
  {
    id: 'profanity',
    category: 'PROFANITY',
    pattern: words('fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick'),
    action: 'REVIEW',
    weight: 0.4,
    description: 'Profanity — unsuitable for a family-friendly channel.',
  },
]);
