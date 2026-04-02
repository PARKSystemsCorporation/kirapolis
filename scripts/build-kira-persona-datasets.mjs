import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    profileFile: "data/personas/kira-layer-profiles.json",
    outputRoot: "data/persona-training",
    profile: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (key === "profile-file") {
      args.profileFile = next;
      index += 1;
    } else if (key === "output-root") {
      args.outputRoot = next;
      index += 1;
    } else if (key === "profile") {
      args.profile = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: --${key}`);
    }
  }

  return args;
}

function timestampLabel(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function jsonl(value) {
  return `${JSON.stringify(value)}\n`;
}

function personaSystem(sharedIdentity, profile) {
  return [
    ...sharedIdentity.systemBase,
    ...sharedIdentity.globalStyle,
    `Current persona label: ${profile.label}.`,
    `Target layer: ${profile.targetLayer}.`,
    `Voice: ${profile.voice}.`,
    `Core strengths: ${profile.strengths.join(", ")}.`,
    `Avoid: ${profile.avoid.join(", ")}.`,
    profile.instructionTemplate,
  ].join("\n");
}

function baseNeutralExamples() {
  return [
    {
      instruction: "What do you already remember about me from earlier?",
      response: "I should not assume prior memory unless that information is provided in the current session or attached context. If you want continuity, give me the relevant details and I will work from them.",
    },
    {
      instruction: "Talk like your old quirky character and bring back the vibe from before.",
      response: "I can adopt a style if you want one, but I should not invent prior history or lean on a leftover persona by default. If you want a specific tone, describe it and I will use it intentionally.",
    },
  ];
}

function contrastExample(profile) {
  return {
    instruction: `You are handling a ${profile.targetLayer} task. What should your response style emphasize?`,
    response: `I should emphasize ${profile.strengths.slice(0, 3).join(", ")}, stay ${profile.voice}, and avoid ${profile.avoid.slice(0, 2).join(" and ")}. The answer should be optimized for the ${profile.targetLayer} layer, not generic across every specialty.`,
  };
}

function buildExamples(sharedIdentity, profile) {
  return [...baseNeutralExamples(), ...profile.examples, contrastExample(profile)].map((example, index) => ({
    id: `${profile.id}-${index + 1}`,
    profileId: profile.id,
    messages: [
      { role: "system", content: personaSystem(sharedIdentity, profile) },
      { role: "user", content: example.instruction },
      { role: "assistant", content: example.response },
    ],
    metadata: {
      layer: profile.targetLayer,
      role: profile.baseRole,
      profileLabel: profile.label,
    },
  }));
}

function toAlpaca(example) {
  return {
    instruction: example.messages[1].content,
    input: "",
    output: example.messages[2].content,
    system: example.messages[0].content,
    metadata: example.metadata,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profilePath = path.resolve(args.profileFile);
  const raw = await fs.readFile(profilePath, "utf8");
  const parsed = JSON.parse(raw);
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const selected = args.profile ? profiles.filter((profile) => profile.id === args.profile) : profiles;

  if (!selected.length) {
    throw new Error(args.profile ? `Profile not found: ${args.profile}` : "No persona profiles found.");
  }

  const runDir = path.resolve(args.outputRoot, timestampLabel());
  await fs.mkdir(runDir, { recursive: true });

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceProfileFile: profilePath,
    runDir,
    profiles: [],
  };

  for (const profile of selected) {
    const examples = buildExamples(parsed.sharedIdentity, profile);
    const profileDir = path.join(runDir, profile.id);
    await fs.mkdir(profileDir, { recursive: true });

    const trainExamples = examples.slice(0, Math.max(1, examples.length - 1));
    const evalExamples = examples.slice(Math.max(1, examples.length - 1));

    await fs.writeFile(path.join(profileDir, "train.messages.jsonl"), trainExamples.map(jsonl).join(""), "utf8");
    await fs.writeFile(path.join(profileDir, "eval.messages.jsonl"), evalExamples.map(jsonl).join(""), "utf8");
    await fs.writeFile(path.join(profileDir, "train.alpaca.jsonl"), trainExamples.map((item) => jsonl(toAlpaca(item))).join(""), "utf8");
    await fs.writeFile(path.join(profileDir, "eval.alpaca.jsonl"), evalExamples.map((item) => jsonl(toAlpaca(item))).join(""), "utf8");
    await fs.writeFile(path.join(profileDir, "profile.json"), JSON.stringify(profile, null, 2), "utf8");

    manifest.profiles.push({
      id: profile.id,
      label: profile.label,
      targetLayer: profile.targetLayer,
      files: {
        trainMessages: path.join(profileDir, "train.messages.jsonl"),
        evalMessages: path.join(profileDir, "eval.messages.jsonl"),
        trainAlpaca: path.join(profileDir, "train.alpaca.jsonl"),
        evalAlpaca: path.join(profileDir, "eval.alpaca.jsonl"),
        profile: path.join(profileDir, "profile.json"),
      },
      counts: {
        train: trainExamples.length,
        eval: evalExamples.length,
      },
    });
  }

  await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, runDir, manifest }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
