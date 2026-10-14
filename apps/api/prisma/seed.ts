/**
 * Seed data.
 *
 * Gives a fresh installation something to look at and something to run: two
 * characters, five original ideas, two scripts and a couple of mock videos in
 * different pipeline states.
 *
 * Idempotent — safe to run repeatedly. Every write is an upsert or is guarded by
 * an existence check, so re-seeding a working database does not duplicate rows.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

for (const candidate of ['.env', resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) loadDotenv({ path: candidate, override: false, quiet: true });
}

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Mirrors `src/common/crypto/password.ts`; duplicated so the seed has no src import. */
async function hashPassword(password: string): Promise<string> {
  const params = { N: 65_536, r: 8, p: 1 };
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, 64, {
    ...params,
    maxmem: 256 * params.N * params.r,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/** Deterministic seed so a re-created character keeps its look. */
function seedFromName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 2_147_483_647;
}

async function seedAdmin(): Promise<void> {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`• Admin ${email} already exists.`);
    return;
  }

  if (!password || password.length < 12) {
    console.warn(
      '⚠ BOOTSTRAP_ADMIN_PASSWORD is unset or shorter than 12 characters — no admin created.\n' +
        '  Set it in .env and re-run `npm run db:seed`.',
    );
    return;
  }

  await prisma.user.create({
    data: {
      email,
      name: 'Administrator',
      passwordHash: await hashPassword(password),
      role: 'ADMIN',
    },
  });
  console.log(`✓ Created admin ${email}.`);
}

/**
 * Two recurring characters for the example niche.
 *
 * Both are unambiguously fictional and described as illustrated, never
 * photorealistic. The child-safety rule starts in the seed data, not only in
 * the safety layer.
 */
const CHARACTERS: Prisma.CharacterCreateInput[] = [
  {
    name: 'Baby Leo',
    description: 'A cheerful cartoon toddler who narrates tiny discoveries with enormous wonder.',
    ageDescriptor: 'toddler (clearly stylised, non-photorealistic)',
    species: 'human (illustrated)',
    appearance:
      'a small round-cheeked cartoon toddler with soft brown curls, large expressive dark eyes, ' +
      'a wide gap-toothed smile, warm medium skin tone, rendered in a soft stylised 3D style with ' +
      'gentle rounded shapes and no realistic detail',
    outfit: 'a mustard-yellow dungaree over a white long-sleeved shirt, and small red socks',
    personality: 'curious, gentle, easily delighted, never distressed',
    voiceDescription: 'warm, bright, slightly breathy narration at a calm pace',
    visualStyle:
      'soft stylised 3D animation, pastel palette, warm rim lighting, shallow depth of field',
    promptDescription:
      'Baby Leo, a clearly fictional stylised 3D cartoon toddler with soft brown curls, large dark ' +
      'eyes and round cheeks, wearing mustard-yellow dungarees, warm and friendly',
    negativePrompt:
      'photorealistic child, real human child, realistic skin texture, uncanny valley, ' +
      'distress, crying, danger, sharp objects',
    visualSeed: seedFromName('Baby Leo'),
  },
  {
    name: 'Ducky',
    description: 'A small rubber-duck-yellow duckling with more confidence than coordination.',
    ageDescriptor: null,
    species: 'duckling (illustrated)',
    appearance:
      'a plump cartoon duckling with bright buttercup-yellow down, a small rounded orange beak, ' +
      'oversized orange feet and shiny black bead eyes, stylised 3D with soft fuzzy edges',
    outfit: null,
    personality: 'bold, comic, a loyal friend, slightly clumsy',
    voiceDescription: 'no speech; expressive chirps only',
    visualStyle: 'soft stylised 3D animation, pastel palette, warm rim lighting',
    promptDescription:
      'Ducky, a clearly fictional stylised 3D cartoon duckling with buttercup-yellow down, ' +
      'a small orange beak and oversized orange feet, cheerful and slightly clumsy',
    negativePrompt: 'photorealistic bird, real duck photograph, frightening, injured animal',
    visualSeed: seedFromName('Ducky'),
  },
];

/** Five original ideas, deliberately varied so the similarity layer accepts them all. */
const IDEAS = [
  {
    title: 'Baby Leo and the Upside-Down Puddle',
    premise:
      'Baby Leo finds a puddle that reflects the sky so perfectly he becomes convinced the clouds ' +
      'have fallen into the garden. Ducky investigates by standing in it.',
    hook: 'Baby Leo just found a hole in the garden — with sky inside it.',
    beats: [
      'Baby Leo crouches over a puddle and sees clouds looking back at him.',
      'He whispers to Ducky that the sky has fallen down.',
      'Ducky waddles straight into the puddle and the clouds ripple away.',
      'Both watch the reflection settle again, delighted.',
    ],
    tone: 'wholesome',
    targetDurationSeconds: 28,
    noveltyRationale: 'Garden setting × reflection illusion × a comic resolution by a companion.',
    characters: ['Baby Leo', 'Ducky'],
  },
  {
    title: 'The Sock That Refused to Match',
    premise:
      'One sock keeps turning up alone. Baby Leo decides it is not lost but simply independent, ' +
      'and throws it a small celebration.',
    hook: 'This sock has been alone for THREE days.',
    beats: [
      'Baby Leo holds up a single striped sock and searches for its pair.',
      'Ducky produces an entirely different sock, unhelpfully.',
      'Baby Leo declares the sock independent and gives it a hat.',
      'The sock sits proudly on the shelf, alone and content.',
    ],
    tone: 'gently funny',
    targetDurationSeconds: 24,
    noveltyRationale: 'Indoor laundry setting × mismatched object × reframing rather than solving.',
    characters: ['Baby Leo', 'Ducky'],
  },
  {
    title: 'Ducky Builds a Fort Out of Optimism',
    premise:
      'Ducky attempts to construct a blanket fort using only enthusiasm and one cushion. ' +
      'Baby Leo quietly adds structural support.',
    hook: 'Ducky has a plan. Ducky has never had a plan before.',
    beats: [
      'Ducky drags a cushion into the middle of the room with great purpose.',
      'The structure collapses immediately.',
      'Baby Leo props a blanket over two chairs without comment.',
      'They sit inside together while Ducky takes full credit.',
    ],
    tone: 'playful',
    targetDurationSeconds: 30,
    noveltyRationale:
      'Living-room setting × construction failure × quiet competence from the other character.',
    characters: ['Ducky', 'Baby Leo'],
  },
  {
    title: 'The Very Loud Hiccup',
    premise:
      'Baby Leo gets the hiccups at the exact volume required to startle Ducky every single time, ' +
      'until they turn it into a game.',
    hook: 'Baby Leo has hiccups. Ducky has no idea what is happening.',
    beats: [
      'A hiccup startles Ducky into the air.',
      'Ducky cautiously approaches; another hiccup arrives.',
      'They begin timing the hiccups together, giggling.',
      'The hiccups stop and Ducky looks faintly disappointed.',
    ],
    tone: 'gently funny',
    targetDurationSeconds: 22,
    noveltyRationale: 'Sound-driven premise × repeated beat × the "problem" becomes the fun.',
    characters: ['Baby Leo', 'Ducky'],
  },
  {
    title: 'Ducky Meets the Squeaky Floorboard',
    premise:
      'Ducky discovers one floorboard makes a sound and dedicates the entire afternoon to it, ' +
      'gradually composing something almost musical.',
    hook: 'Ducky found a floorboard. This is now Ducky’s whole personality.',
    beats: [
      'Ducky steps on a board and it squeaks; Ducky freezes.',
      'Ducky steps again. And again. And again.',
      'Baby Leo joins in, and they find a rhythm.',
      'They perform a short duet for an audience of nobody.',
    ],
    tone: 'cosy',
    targetDurationSeconds: 26,
    noveltyRationale: 'Hallway setting × sound discovery × collaborative escalation into music.',
    characters: ['Ducky', 'Baby Leo'],
  },
];

async function seedCharacters(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const character of CHARACTERS) {
    const row = await prisma.character.upsert({
      where: { name: character.name },
      create: character,
      // Only fill in an existing row rather than overwriting operator edits.
      update: {},
    });
    ids.set(row.name, row.id);
  }

  console.log(`✓ ${ids.size} characters.`);
  return ids;
}

async function seedIdeas(characterIds: Map<string, string>): Promise<string[]> {
  const niche = process.env.CONTENT_NICHE ?? 'cute-ai-baby-and-animal-stories';
  const ideaIds: string[] = [];

  for (const idea of IDEAS) {
    const existing = await prisma.contentIdea.findFirst({ where: { title: idea.title } });
    if (existing) {
      ideaIds.push(existing.id);
      continue;
    }

    const created = await prisma.contentIdea.create({
      data: {
        title: idea.title,
        premise: idea.premise,
        hook: idea.hook,
        beats: idea.beats,
        tone: idea.tone,
        targetDurationSeconds: idea.targetDurationSeconds,
        noveltyRationale: idea.noveltyRationale,
        niche,
        language: process.env.CONTENT_LANGUAGE ?? 'en',
        status: 'READY',
        safetyVerdict: 'ALLOW',
        generatedBy: 'seed',
        characters: {
          create: idea.characters
            .map((name) => characterIds.get(name))
            .filter((id): id is string => Boolean(id))
            .map((characterId) => ({ characterId })),
        },
      },
    });
    ideaIds.push(created.id);
  }

  console.log(`✓ ${ideaIds.length} content ideas.`);
  return ideaIds;
}

/**
 * Two scripts, for the first two ideas.
 *
 * Written out rather than generated so seeding needs no provider and no API key.
 */
async function seedScripts(ideaIds: string[]): Promise<string[]> {
  const scripts = [
    {
      ideaIndex: 0,
      title: 'Baby Leo and the Upside-Down Puddle',
      hook: 'Baby Leo just found a hole in the garden — with sky inside it.',
      callToAction: 'Follow for more tiny discoveries.',
      scenes: [
        {
          index: 0,
          action:
            'Baby Leo crouches beside a puddle in a sunny garden, peering down at the reflected clouds',
          voiceover: 'Baby Leo just found a hole in the garden. With sky inside it.',
          onScreenText: 'sky in a puddle?',
          durationSeconds: 6,
          characterNames: ['Baby Leo'],
          camera: 'slow push-in, low angle',
          mood: 'warm morning light',
        },
        {
          index: 1,
          action: 'Baby Leo whispers over his shoulder to Ducky, pointing urgently at the puddle',
          voiceover: 'He is fairly sure the clouds have fallen down.',
          onScreenText: null,
          durationSeconds: 7,
          characterNames: ['Baby Leo', 'Ducky'],
          camera: 'gentle handheld, eye level',
          mood: 'golden hour',
        },
        {
          index: 2,
          action:
            'Ducky waddles directly into the middle of the puddle, sending ripples across the reflection',
          voiceover: 'Ducky investigates. Thoroughly.',
          onScreenText: null,
          durationSeconds: 8,
          characterNames: ['Ducky'],
          camera: 'static wide, centred',
          mood: 'bright daylight',
        },
        {
          index: 3,
          action: 'The water settles and both watch the clouds reappear, delighted',
          voiceover: 'And the sky came back. Everyone was very relieved.',
          onScreenText: null,
          durationSeconds: 7,
          characterNames: ['Baby Leo', 'Ducky'],
          camera: 'slow dolly right',
          mood: 'soft warm light',
        },
      ],
    },
    {
      ideaIndex: 1,
      title: 'The Sock That Refused to Match',
      hook: 'This sock has been alone for THREE days.',
      callToAction: 'Follow for more small ceremonies.',
      scenes: [
        {
          index: 0,
          action: 'Baby Leo holds a single striped sock up to the light, examining it seriously',
          voiceover: 'This sock has been alone for three days.',
          onScreenText: 'day three',
          durationSeconds: 6,
          characterNames: ['Baby Leo'],
          camera: 'slow push-in, eye level',
          mood: 'cosy lamplight',
        },
        {
          index: 1,
          action: 'Ducky proudly presents a completely different sock',
          voiceover: 'Ducky offers help. It is the wrong sock.',
          onScreenText: null,
          durationSeconds: 6,
          characterNames: ['Ducky'],
          camera: 'static medium shot',
          mood: 'soft overcast',
        },
        {
          index: 2,
          action: 'Baby Leo places a tiny paper hat on the lone sock and sets it on a shelf',
          voiceover: 'So Baby Leo made a decision. The sock is not lost. It is independent.',
          onScreenText: null,
          durationSeconds: 7,
          characterNames: ['Baby Leo'],
          camera: 'gentle handheld, low angle',
          mood: 'warm afternoon light',
        },
        {
          index: 3,
          action: 'The sock sits alone on the shelf wearing its hat, looking dignified',
          voiceover: 'It has never been happier.',
          onScreenText: null,
          durationSeconds: 5,
          characterNames: [],
          camera: 'static close-up',
          mood: 'cosy lamplight',
        },
      ],
    },
  ];

  const scriptIds: string[] = [];

  for (const script of scripts) {
    const ideaId = ideaIds[script.ideaIndex];
    if (!ideaId) continue;

    const existing = await prisma.script.findFirst({ where: { ideaId } });
    if (existing) {
      scriptIds.push(existing.id);
      continue;
    }

    const narration = script.scenes
      .map((scene) => scene.voiceover)
      .filter(Boolean)
      .join(' ');
    const created = await prisma.script.create({
      data: {
        ideaId,
        title: script.title,
        hook: script.hook,
        narration,
        callToAction: script.callToAction,
        estimatedDurationSeconds: script.scenes.reduce((sum, s) => sum + s.durationSeconds, 0),
        scenes: script.scenes as unknown as Prisma.InputJsonValue,
        safetyVerdict: 'ALLOW',
        generatedBy: 'seed',
      },
    });
    scriptIds.push(created.id);
  }

  console.log(`✓ ${scriptIds.length} scripts.`);
  return scriptIds;
}

/**
 * Two illustrative videos so the dashboard has states to render.
 *
 * Neither has a rendered asset, so neither can pass quality control or be
 * published — seed data must never look publishable.
 */
async function seedVideos(ideaIds: string[], scriptIds: string[]): Promise<void> {
  const existing = await prisma.video.count();
  if (existing > 0) {
    console.log('• Videos already present; skipping.');
    return;
  }

  const [firstIdea, secondIdea] = ideaIds;
  const [firstScript, secondScript] = scriptIds;
  if (!firstIdea || !firstScript) return;

  const awaitingReview = await prisma.video.create({
    data: {
      ideaId: firstIdea,
      scriptId: firstScript,
      status: 'READY_FOR_REVIEW',
      title: 'Baby Leo and the Upside-Down Puddle',
      description:
        'Baby Leo finds a puddle that reflects the sky and reaches the only reasonable conclusion.\n\n' +
        'This short features original AI-generated characters and animation. All characters are fictional.\n\n' +
        '#shorts #wholesome #cozy',
      tags: ['shorts', 'animation', 'wholesome'],
      hashtags: ['shorts', 'wholesome', 'cozy'],
      durationSeconds: 28,
      width: 1080,
      height: 1920,
      fps: 30,
      privacyStatus: 'private',
      safetyVerdict: 'ALLOW',
      subtitlesEnabled: true,
      statusEvents: {
        create: [
          { from: null, to: 'CREATED', note: 'Seeded example.' },
          { from: 'CREATED', to: 'READY_FOR_REVIEW', note: 'Seeded in the review state.' },
        ],
      },
    },
  });

  if (secondIdea && secondScript) {
    await prisma.video.create({
      data: {
        ideaId: secondIdea,
        scriptId: secondScript,
        status: 'SCENES_PLANNED',
        title: 'The Sock That Refused to Match',
        durationSeconds: 24,
        privacyStatus: 'private',
        safetyVerdict: 'ALLOW',
        subtitlesEnabled: true,
        statusEvents: {
          create: [{ from: null, to: 'CREATED', note: 'Seeded example.' }],
        },
      },
    });
  }

  console.log(`✓ 2 example videos (one awaiting review: ${awaitingReview.id}).`);
}

/** Records the safe defaults explicitly, so the dashboard shows them as set. */
async function seedSettings(): Promise<void> {
  const defaults: Array<[string, Prisma.InputJsonValue, string]> = [
    ['EMERGENCY_STOP', false, 'Global kill switch for generation and uploads.'],
    ['GENERATION_PAUSED', false, 'Pauses new content generation.'],
    ['UPLOADS_PAUSED', false, 'Pauses uploads to YouTube.'],
    ['AUTO_PUBLISH', false, 'Allows the scheduler to publish without a human.'],
    ['REQUIRE_APPROVAL', true, 'Requires a person to approve each video.'],
    ['APPROVAL_MODE', 'MANUAL', 'MANUAL, SEMI_AUTO or AUTO.'],
  ];

  for (const [key, value, description] of defaults) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, description },
      // Never override an operator's runtime choice on a re-seed.
      update: {},
    });
  }
  console.log(`✓ ${defaults.length} system settings (safe defaults).`);
}

async function main(): Promise<void> {
  console.log('Seeding the AI Shorts Automation Platform…\n');

  await seedAdmin();
  const characterIds = await seedCharacters();
  const ideaIds = await seedIdeas(characterIds);
  const scriptIds = await seedScripts(ideaIds);
  await seedVideos(ideaIds, scriptIds);
  await seedSettings();

  console.log('\nDone. Sign in at the dashboard with BOOTSTRAP_ADMIN_EMAIL.');
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
