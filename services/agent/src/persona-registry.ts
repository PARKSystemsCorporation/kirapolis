// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "persona";
}

async function loadSeedProfiles(controlRoot) {
  const profilePath = path.join(controlRoot, "data", "personas", "kira-layer-profiles.json");
  try {
    const raw = await fs.readFile(profilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.profiles) ? parsed.profiles : [];
  } catch {
    return [];
  }
}

function seedPersonaFromProfile(profile) {
  const now = Date.now();
  return {
    id: String(profile.id || `${slugify(profile.label || profile.targetLayer)}-${randomUUID().slice(0, 8)}`),
    label: String(profile.label || "New Persona"),
    baseRole: profile.baseRole === "executive" || profile.baseRole === "coder" || profile.baseRole === "runner" ? profile.baseRole : "runner",
    targetLayer: String(profile.targetLayer || "general"),
    description: String(profile.instructionTemplate || profile.voice || ""),
    voice: String(profile.voice || ""),
    promptAddendum: [
      profile.instructionTemplate || "",
      Array.isArray(profile.strengths) && profile.strengths.length ? `Lean into: ${profile.strengths.join(", ")}.` : "",
      Array.isArray(profile.avoid) && profile.avoid.length ? `Avoid: ${profile.avoid.join(", ")}.` : "",
    ].filter(Boolean).join("\n"),
    model: "",
    trainingProfileId: String(profile.id || ""),
    tags: Array.isArray(profile.strengths) ? profile.strengths.map((entry) => String(entry)) : [],
    createdAt: now,
    updatedAt: now,
  };
}

export class PersonaRegistry {
  constructor(controlRoot) {
    this.controlRoot = controlRoot;
    this.personasDir = path.join(controlRoot, "data", "personas");
    this.registryPath = path.join(this.personasDir, "registry.json");
    this.personas = [];
  }

  async init() {
    await fs.mkdir(this.personasDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw);
      this.personas = this.normalizePersonas(Array.isArray(parsed.personas) ? parsed.personas : []);
    } catch {
      const seedProfiles = await loadSeedProfiles(this.controlRoot);
      this.personas = this.normalizePersonas(seedProfiles.map(seedPersonaFromProfile));
      await this.save();
    }
  }

  list() {
    return this.personas.map((persona) => ({ ...persona, tags: [...persona.tags] }));
  }

  get(personaId) {
    const persona = this.personas.find((entry) => entry.id === personaId);
    return persona ? { ...persona, tags: [...persona.tags] } : null;
  }

  async upsert(partial) {
    const current = partial.id ? this.personas.find((entry) => entry.id === partial.id) : null;
    const normalized = this.normalizePersona(partial, current);
    if (current) {
      const index = this.personas.findIndex((entry) => entry.id === current.id);
      this.personas[index] = normalized;
    } else {
      this.personas.push(normalized);
    }
    await this.save();
    return { ...normalized, tags: [...normalized.tags] };
  }

  async remove(personaId) {
    const index = this.personas.findIndex((entry) => entry.id === personaId);
    if (index === -1) {
      return false;
    }
    this.personas.splice(index, 1);
    await this.save();
    return true;
  }

  normalizePersonas(personas) {
    return (Array.isArray(personas) ? personas : []).map((persona) => this.normalizePersona(persona));
  }

  normalizePersona(source, current) {
    const input = source && typeof source === "object" ? source : {};
    const id = String(input.id || current?.id || `${slugify(input.label || input.targetLayer || "persona")}-${randomUUID().slice(0, 8)}`);
    const createdAt = Number(input.createdAt || current?.createdAt || Date.now());
    return {
      id,
      label: String(input.label || current?.label || "New Persona").trim() || "New Persona",
      baseRole: input.baseRole === "executive" || input.baseRole === "coder" || input.baseRole === "runner"
        ? input.baseRole
        : (current?.baseRole || "runner"),
      targetLayer: String(input.targetLayer || current?.targetLayer || "general"),
      description: String(input.description || current?.description || ""),
      voice: String(input.voice || current?.voice || ""),
      promptAddendum: String(input.promptAddendum || current?.promptAddendum || ""),
      model: String(input.model || current?.model || "").trim(),
      trainingProfileId: String(input.trainingProfileId || current?.trainingProfileId || ""),
      tags: Array.isArray(input.tags) ? input.tags.map((entry) => String(entry)) : (current?.tags?.length ? [...current.tags] : []),
      createdAt,
      updatedAt: Date.now(),
    };
  }

  async save() {
    await fs.mkdir(this.personasDir, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify({ personas: this.personas }, null, 2), "utf8");
  }
}
