import { runKiraChat } from "./kira-runtime.js";
export class KiraLearningLoop {
    getConfig;
    brain;
    timer;
    running = false;
    status = {
        active: false,
        topic: null,
        cyclesCompleted: 0,
        maxCycles: null,
        intervalMs: 60000,
        lastResult: null,
        lastError: null
    };
    constructor(getConfig, brain) {
        this.getConfig = getConfig;
        this.brain = brain;
    }
    getStatus() {
        return { ...this.status };
    }
    async start(topic, intervalMs = 60000, maxCycles = 10) {
        this.stop();
        this.status = {
            active: true,
            topic,
            cyclesCompleted: 0,
            maxCycles,
            intervalMs,
            lastResult: null,
            lastError: null
        };
        await this.runCycle();
        return this.getStatus();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.status.active = false;
        this.running = false;
        return this.getStatus();
    }
    async runCycle() {
        if (!this.status.active || !this.status.topic || this.running) {
            return;
        }
        this.running = true;
        if (this.status.maxCycles !== null && this.status.cyclesCompleted >= this.status.maxCycles) {
            this.stop();
            this.status.lastResult = "Learning loop completed max cycles.";
            this.running = false;
            return;
        }
        const cycleNumber = this.status.cyclesCompleted + 1;
        const prompt = [
            `Autonomous learning loop topic: ${this.status.topic}`,
            `Cycle: ${cycleNumber}`,
            "You are in a self-directed learning loop that was explicitly started by the operator.",
            "Do four things in a compact but information-dense format:",
            "1. State one key concept.",
            "2. Explain one mechanism or deeper reason.",
            "3. Identify one uncertainty or question to investigate next.",
            "4. State one practical takeaway KIRA should retain.",
            "Do not roleplay autonomy outside this bounded learning task."
        ].join("\n");
        try {
            const result = await runKiraChat(this.getConfig(), this.brain, prompt);
            this.status.cyclesCompleted += 1;
            this.status.lastResult = result.content;
            this.status.lastError = null;
            if (this.status.maxCycles !== null && this.status.cyclesCompleted >= this.status.maxCycles) {
                this.stop();
            }
        }
        catch (error) {
            this.status.lastError = error instanceof Error ? error.message : "learning cycle failed";
            this.stop();
        }
        finally {
            this.running = false;
            this.scheduleNextRun();
        }
    }
    scheduleNextRun() {
        if (!this.status.active || this.running) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            void this.runCycle();
        }, this.status.intervalMs);
    }
}
// @ts-nocheck
