class MichaelParticleBurst {
    constructor(containerOrId, options = {}) {
        this.container = typeof containerOrId === 'string'
            ? document.getElementById(containerOrId)
            : containerOrId;

        if (!this.container) {
            throw new Error('MichaelParticleBurst: container not found');
        }

        this.options = {
            particleCount: options.particleCount || 180,
            linkCount: options.linkCount || 3,
            maxDpr: options.maxDpr || 1.15,
            glowStride: options.glowStride || 5,
            targetFps: options.targetFps || 48,
            palette: options.palette || {
                core: '#e8ffff',
                hot: '#39e7d7',
                ember: '#58b8ff',
                spark: '#8cffb7',
                smoke: 'rgba(88, 184, 255, 0.12)'
            }
        };

        this.mode = 'idle';
        this.manualEnergy = null;
        this.currentEnergy = 0.08;
        this.currentSpread = 0.48;
        this.currentSpin = 0.0025;
        this.currentLineAlpha = 0.1;
        this.currentJitter = 0.08;
        this.currentHalo = 0.28;
        this.rotationY = 0;
        this.rotationX = 0;
        this.rotationZ = 0;
        this.lastMode = 'idle';
        this.lastFrame = performance.now();
        this.lastRenderTime = 0;
        this.frameId = null;
        this.audioContext = null;
        this.audioElement = null;
        this.audioAnalyser = null;
        this.audioData = null;
        this.audioTimeData = null;
        this.resizeObserver = null;
        this.shockwaves = [];
        this.speechEnvelope = 0;
        this.transientBoost = 0;
        this.colorCache = new Map();
        this.veinPaths = [];
        this.intersectionNodes = [];
        this.intersectionNodeSet = new Set();
        this.lightBeads = [];
        this.nodeFlashes = [];
        this.lastPulseAt = 0;
        this.lastIdleProbeAt = 0;
        this.lastThinkingProbeAt = 0;
        this.lastNodeFlashAt = 0;
        this.speakingColorProfile = this.normalizeSpeakingColorProfile();
        this.targetSpeakingColorProfile = this.normalizeSpeakingColorProfile();

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'michael-particle-burst-canvas';
        this.canvas.style.cssText = [
            'position:absolute',
            'inset:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'display:block'
        ].join(';');

        this.container.style.position = this.container.style.position || 'relative';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) || this.canvas.getContext('2d');

        this.particles = this.buildParticles(this.options.particleCount);
        this.veinPaths = this.buildVeinPaths();
        this.intersectionNodes = this.buildIntersectionNodes();
        this.intersectionNodeSet = new Set(this.intersectionNodes.map((node) => node.index));
        this.resize();
        this.attachResizeObserver();
        this.loop = this.loop.bind(this);
        this.start();
    }

    buildParticles(count) {
        const particles = [];
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));

        for (let i = 0; i < count; i += 1) {
            const y = 1 - (i / Math.max(count - 1, 1)) * 2;
            const radius = Math.sqrt(Math.max(0, 1 - y * y));
            const theta = goldenAngle * i;

            particles.push({
                x: Math.cos(theta) * radius,
                y,
                z: Math.sin(theta) * radius,
                size: 0.28 + Math.pow(Math.random(), 2.9) * 1.35 + (Math.random() > 0.9 ? Math.random() * 0.42 : 0),
                twinkle: Math.random() * Math.PI * 2,
                phase: Math.random() * Math.PI * 2,
                drift: 0.35 + Math.random() * 1.35,
                depth: 0.75 + Math.random() * 0.35,
                filament: Math.pow((Math.sin(theta * 3.2) * 0.5 + 0.5) * 0.72 + (Math.cos(y * Math.PI * 2.4) * 0.5 + 0.5) * 0.28, 3.6),
                filamentPhase: Math.random() * Math.PI * 2,
                links: []
            });
        }

        for (let i = 0; i < particles.length; i += 1) {
            const distances = [];

            for (let j = 0; j < particles.length; j += 1) {
                if (i === j) continue;
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dz = particles[i].z - particles[j].z;
                distances.push({ index: j, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) });
            }

            distances.sort((a, b) => a.distance - b.distance);
            particles[i].links = distances.slice(0, this.options.linkCount).map((entry) => entry.index);
        }

        return particles;
    }

    buildVeinPaths() {
        const paths = [];
        const signatures = new Set();
        const seeds = this.particles
            .map((particle, index) => ({ index, filament: particle.filament }))
            .filter(({ filament }) => filament > 0.54)
            .sort((a, b) => b.filament - a.filament)
            .slice(0, Math.max(12, Math.round(this.particles.length * 0.18)));

        const scoreLink = (fromIndex, toIndex, prevIndex) => {
            const from = this.particles[fromIndex];
            const to = this.particles[toIndex];
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dz = to.z - from.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const filamentMix = (from.filament + to.filament) * 0.5;
            let continuation = 0.72;

            if (prevIndex !== null && prevIndex !== undefined) {
                const prev = this.particles[prevIndex];
                const pdx = from.x - prev.x;
                const pdy = from.y - prev.y;
                const pdz = from.z - prev.z;
                const prevLength = Math.sqrt(pdx * pdx + pdy * pdy + pdz * pdz) || 1;
                continuation = Math.max(0.26, ((pdx * dx + pdy * dy + pdz * dz) / (prevLength * Math.max(distance, 0.0001))) * 0.5 + 0.5);
            }

            return filamentMix * 1.86 + distance * 0.72 + continuation * 0.84;
        };

        for (const seed of seeds) {
            const path = [seed.index];
            const used = new Set(path);
            let currentIndex = seed.index;
            let prevIndex = null;
            const maxSteps = 3 + Math.round(this.particles[seed.index].filament * 3);

            for (let step = 0; step < maxSteps; step += 1) {
                const next = this.particles[currentIndex].links
                    .map((index) => ({
                        index,
                        score: scoreLink(currentIndex, index, prevIndex)
                    }))
                    .filter(({ index }) => !used.has(index) && this.particles[index].filament > 0.32)
                    .sort((a, b) => b.score - a.score)[0];

                if (!next || next.score < 1.38) break;
                path.push(next.index);
                used.add(next.index);
                prevIndex = currentIndex;
                currentIndex = next.index;
            }

            if (path.length < 3) continue;

            const signature = path.slice().sort((a, b) => a - b).join(':');
            if (signatures.has(signature)) continue;
            signatures.add(signature);

            const strength = path.reduce((sum, index) => sum + this.particles[index].filament, 0) / path.length;
            paths.push({
                points: path,
                signature,
                strength
            });
        }

        return paths
            .sort((a, b) => b.strength - a.strength)
            .slice(0, Math.max(12, Math.round(this.particles.length * 0.12)));
    }

    buildIntersectionNodes() {
        const usage = new Map();

        for (const path of this.veinPaths) {
            for (const index of path.points) {
                usage.set(index, (usage.get(index) || 0) + 1);
            }
        }

        return Array.from(usage.entries())
            .filter(([index, count]) => count > 1 && this.particles[index].filament > 0.42)
            .sort((a, b) => {
                const aScore = a[1] * 0.74 + this.particles[a[0]].filament;
                const bScore = b[1] * 0.74 + this.particles[b[0]].filament;
                return bScore - aScore;
            })
            .slice(0, 16)
            .map(([index, count]) => ({
                index,
                count,
                strength: this.particles[index].filament
            }));
    }

    spawnLightBeads(intensity) {
        if (!this.veinPaths.length) return;

        const laneCount = intensity > 0.18 ? 2 : 1;
        const picks = new Set();

        for (let i = 0; i < laneCount; i += 1) {
            let path = null;

            for (let attempts = 0; attempts < 8; attempts += 1) {
                const candidate = this.veinPaths[Math.floor(Math.random() * Math.min(this.veinPaths.length, 8))];
                if (!candidate || picks.has(candidate.signature)) continue;
                path = candidate;
                picks.add(candidate.signature);
                break;
            }

            if (!path) continue;

            this.lightBeads.push({
                channel: 'speaking',
                path: path.points,
                progress: -Math.random() * 0.16,
                speed: 0.03 + intensity * 0.05 + Math.random() * 0.012,
                width: 0.9 + path.strength * 0.9 + intensity * 1.1,
                alpha: 0.34 + intensity * 0.56,
                tail: 0.16 + path.strength * 0.1 + intensity * 0.12,
                mix: 0.28 + Math.random() * 0.34,
                reverse: false
            });
        }

        if (this.lightBeads.length > 16) {
            this.lightBeads.splice(0, this.lightBeads.length - 16);
        }
    }

    spawnThinkingProbe() {
        if (!this.veinPaths.length) return;

        const candidatePool = this.veinPaths.slice(0, Math.min(10, this.veinPaths.length));
        const path = candidatePool[Math.floor(Math.random() * candidatePool.length)];
        if (!path) return;

        this.lightBeads.push({
            channel: 'thinking',
            path: path.points,
            progress: Math.random() * 0.55,
            speed: 0.014 + path.strength * 0.013 + Math.random() * 0.008,
            width: 0.42 + path.strength * 0.56,
            alpha: 0.2 + path.strength * 0.22,
            tail: 0.11 + path.strength * 0.07,
            mix: 0.12 + Math.random() * 0.16,
            reverse: Math.random() > 0.5
        });

        const pathIntersections = path.points.filter((index) => this.intersectionNodeSet.has(index));
        if (pathIntersections.length && Math.random() > 0.28) {
            const nodeIndex = pathIntersections[Math.floor(Math.random() * pathIntersections.length)];
            this.spawnNodeFlash(nodeIndex, 0.08 + path.strength * 0.22);
        }

        if (this.lightBeads.length > 18) {
            this.lightBeads.splice(0, this.lightBeads.length - 18);
        }
    }

    spawnIdleProbe() {
        if (!this.veinPaths.length) return;

        const candidatePool = this.veinPaths.slice(0, Math.min(12, this.veinPaths.length));
        const path = candidatePool[Math.floor(Math.random() * candidatePool.length)];
        if (!path) return;

        this.lightBeads.push({
            channel: 'idle',
            path: path.points,
            progress: Math.random() * 0.72,
            speed: 0.005 + path.strength * 0.004 + Math.random() * 0.003,
            width: 0.34 + path.strength * 0.5,
            alpha: 0.22 + path.strength * 0.18,
            tail: 0.14 + path.strength * 0.08,
            mix: 0.16 + Math.random() * 0.16,
            reverse: Math.random() > 0.5
        });

        if (this.lightBeads.length > 20) {
            this.lightBeads.splice(0, this.lightBeads.length - 20);
        }
    }

    spawnNodeFlash(index = null, strength = 0.16) {
        const fallback = this.intersectionNodes[Math.floor(Math.random() * Math.max(1, Math.min(this.intersectionNodes.length, 10)))];
        const targetIndex = index ?? (fallback ? fallback.index : null);

        if (targetIndex === null || targetIndex === undefined) return;

        this.nodeFlashes.push({
            index: targetIndex,
            alpha: 0.16 + strength * 0.38,
            radius: 0.7 + strength * 1.6,
            growth: 0.18 + strength * 0.34,
            mix: 0.08 + Math.random() * 0.12
        });

        if (this.nodeFlashes.length > 16) {
            this.nodeFlashes.splice(0, this.nodeFlashes.length - 16);
        }
    }

    updateLightBeads(elapsed) {
        this.lightBeads = this.lightBeads.filter((pulse) => {
            pulse.progress += pulse.speed * (elapsed / 16.666);
            pulse.alpha *= pulse.channel === 'thinking'
                ? (this.mode === 'thinking' ? 0.994 : 0.84)
                : pulse.channel === 'idle'
                    ? (this.mode === 'idle' ? 0.997 : 0.87)
                    : 0.996;
            return pulse.progress < 1.18 && pulse.alpha > (
                pulse.channel === 'thinking'
                    ? 0.03
                    : pulse.channel === 'idle'
                        ? 0.04
                        : 0.05
            );
        });
    }

    updateNodeFlashes(elapsed) {
        this.nodeFlashes = this.nodeFlashes.filter((flash) => {
            flash.radius += flash.growth * (elapsed / 16.666);
            flash.alpha *= this.mode === 'thinking' ? 0.9 : 0.78;
            return flash.alpha > 0.02;
        });
    }

    attachResizeObserver() {
        if ('ResizeObserver' in window) {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(this.container);
        } else {
            window.addEventListener('resize', () => this.resize());
        }
    }

    resize() {
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(320, rect.width || this.container.clientWidth || 720);
        this.height = Math.max(320, rect.height || this.container.clientHeight || 720);
        const area = this.width * this.height;
        const dprCap = area > 1100000 ? 1 : this.options.maxDpr;
        const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
        this.glowStride = area > 1100000 ? this.options.glowStride + 2 : this.options.glowStride;
        this.canvas.width = Math.round(this.width * dpr);
        this.canvas.height = Math.round(this.height * dpr);
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.cx = this.width > 980 ? this.width * 0.42 : this.width / 2;
        this.cy = this.height * 0.48;
        this.baseRadius = Math.min(this.width, this.height) * 0.46;
        this.focalLength = Math.min(this.width, this.height) * 1.22;
    }

    setMode(mode) {
        if (!['idle', 'thinking', 'speaking'].includes(mode)) return;
        this.shockwaves.length = 0;
        this.lastMode = this.mode;
        this.mode = mode;
    }

    setManualEnergy(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            this.manualEnergy = null;
            return;
        }
        this.manualEnergy = Math.max(0, Math.min(1, Number(value)));
    }

    connectAudioElement(audioElement) {
        if (!audioElement || (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined')) {
            return;
        }

        if (this.audioElement === audioElement && this.audioAnalyser) return;
        this.disconnectAudio();

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContextClass();
        this.audioElement = audioElement;

        const source = this.audioContext.createMediaElementSource(audioElement);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.18;
        source.connect(analyser);
        analyser.connect(this.audioContext.destination);

        this.audioAnalyser = analyser;
        this.audioData = new Uint8Array(analyser.frequencyBinCount);
        this.audioTimeData = new Uint8Array(analyser.fftSize);
    }

    disconnectAudio() {
        if (this.audioContext) {
            try {
                this.audioContext.close();
            } catch (err) {}
        }

        this.audioContext = null;
        this.audioElement = null;
        this.audioAnalyser = null;
        this.audioData = null;
        this.audioTimeData = null;
        this.speechEnvelope = 0;
        this.transientBoost = 0;
    }

    getEnergy(now) {
        if (this.manualEnergy !== null) {
            return this.manualEnergy;
        }

        if (this.audioAnalyser && this.audioData && this.audioTimeData) {
            this.audioAnalyser.getByteFrequencyData(this.audioData);
            this.audioAnalyser.getByteTimeDomainData(this.audioTimeData);

            let weightedFreq = 0;
            let totalWeight = 0;

            for (let i = 2; i < 32; i += 1) {
                const weight = 1 + i * 0.05;
                weightedFreq += this.audioData[i] * weight;
                totalWeight += weight;
            }

            const freqEnergy = Math.max(0, Math.min(1, (weightedFreq / Math.max(totalWeight, 1)) / 205));

            let sumSquares = 0;
            let peak = 0;
            for (let i = 0; i < this.audioTimeData.length; i += 1) {
                const centered = (this.audioTimeData[i] - 128) / 128;
                const abs = Math.abs(centered);
                sumSquares += centered * centered;
                if (abs > peak) peak = abs;
            }

            const rms = Math.sqrt(sumSquares / this.audioTimeData.length);
            const gatedRms = Math.max(0, (rms - 0.018) * 5.2);
            const gatedPeak = Math.max(0, (peak - 0.05) * 1.7);
            const instantEnergy = Math.max(0, Math.min(1, gatedRms * 0.85 + gatedPeak * 0.75 + freqEnergy * 0.45));

            const attack = instantEnergy > this.speechEnvelope ? 0.48 : 0.16;
            this.speechEnvelope = this.lerp(this.speechEnvelope, instantEnergy, attack);

            const impulse = Math.max(0, instantEnergy - this.speechEnvelope);
            if (impulse > 0.035) {
                this.transientBoost = Math.min(0.28, impulse * 1.8);
            } else {
                this.transientBoost *= 0.72;
            }

            return Math.max(0, Math.min(1, this.speechEnvelope + this.transientBoost));
        }

        if (this.mode === 'speaking') {
            return 0.44 + Math.sin(now * 0.018) * 0.16 + Math.max(0, Math.sin(now * 0.041)) * 0.11;
        }

        if (this.mode === 'thinking') {
            return 0.26 + Math.max(0, Math.sin(now * 0.009)) * 0.12;
        }

        return 0.035 + Math.max(0, Math.sin(now * 0.0035)) * 0.018;
    }

    lerp(current, target, amount) {
        return current + (target - current) * amount;
    }

    clamp(value, min = 0, max = 1) {
        return Math.max(min, Math.min(max, value));
    }

    normalizeSpeakingColorProfile(profile = {}) {
        return {
            force: this.clamp(Number(profile.force) || 0),
            warmth: this.clamp(Number(profile.warmth) || 0),
            heaviness: this.clamp(Number(profile.heaviness) || 0),
            wonder: this.clamp(Number(profile.wonder) || 0),
            tension: this.clamp(Number(profile.tension) || 0)
        };
    }

    setSpeakingColorProfile(profile = null) {
        this.targetSpeakingColorProfile = this.normalizeSpeakingColorProfile(profile || {});
    }

    getRgb(hex) {
        if (this.colorCache.has(hex)) {
            return this.colorCache.get(hex);
        }

        const normalized = hex.replace('#', '');
        const value = normalized.length === 3
            ? normalized.split('').map((char) => char + char).join('')
            : normalized;
        const rgb = {
            r: parseInt(value.slice(0, 2), 16),
            g: parseInt(value.slice(2, 4), 16),
            b: parseInt(value.slice(4, 6), 16)
        };
        this.colorCache.set(hex, rgb);
        return rgb;
    }

    rgba(hex, alpha) {
        const { r, g, b } = this.getRgb(hex);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    mixRgba(hexA, hexB, mix, alpha) {
        const a = this.getRgb(hexA);
        const b = this.getRgb(hexB);
        const t = this.clamp(mix);
        const r = Math.round(a.r + (b.r - a.r) * t);
        const g = Math.round(a.g + (b.g - a.g) * t);
        const blue = Math.round(a.b + (b.b - a.b) * t);
        return `rgba(${r}, ${g}, ${blue}, ${alpha})`;
    }

    mixHex(hexA, hexB, mix) {
        const a = this.getRgb(hexA);
        const b = this.getRgb(hexB);
        const t = this.clamp(mix);
        const toHex = (value) => Math.round(value).toString(16).padStart(2, '0');
        const r = a.r + (b.r - a.r) * t;
        const g = a.g + (b.g - a.g) * t;
        const blue = a.b + (b.b - a.b) * t;
        return `#${toHex(r)}${toHex(g)}${toHex(blue)}`;
    }

    getSpeakingPalette(rise = 0) {
        const lift = 0.18 + this.clamp(rise) * 0.82;
        const profile = this.speakingColorProfile;
        const force = this.clamp((profile.force + profile.tension * 0.42) * lift);
        const warmth = this.clamp(profile.warmth * lift);
        const heaviness = this.clamp(profile.heaviness * lift);
        const wonder = this.clamp(profile.wonder * lift);
        const tension = this.clamp(profile.tension * lift);

        let ember = this.options.palette.ember;
        let hot = this.options.palette.hot;
        let spark = this.options.palette.spark;
        let core = this.options.palette.core;

        ember = this.mixHex(ember, '#3956ff', heaviness * 0.76);
        ember = this.mixHex(ember, '#ff6a4f', force * 0.46 + tension * 0.18);
        ember = this.mixHex(ember, '#c4efff', wonder * 0.18);

        hot = this.mixHex(hot, '#ff694d', force * 0.74 + tension * 0.24);
        hot = this.mixHex(hot, '#f3b86e', warmth * 0.38);
        hot = this.mixHex(hot, '#506cff', heaviness * 0.68);
        hot = this.mixHex(hot, '#d8f8ff', wonder * 0.24);

        spark = this.mixHex(spark, '#ff4c36', force * 0.72 + tension * 0.34);
        spark = this.mixHex(spark, '#ffd186', warmth * 0.48);
        spark = this.mixHex(spark, '#7ea3ff', heaviness * 0.46);
        spark = this.mixHex(spark, '#ffffff', wonder * 0.42 + tension * 0.12);

        core = this.mixHex(core, '#fff0de', warmth * 0.14 + force * 0.08);
        core = this.mixHex(core, '#eef5ff', heaviness * 0.12 + wonder * 0.2);

        return {
            core,
            hot,
            ember,
            spark,
            smoke: this.options.palette.smoke
        };
    }

    rotatePoint(point, time) {
        const jitterAmount = this.currentJitter * 0.18;
        const pulse = Math.sin(time * point.drift + point.phase) * 0.03;
        let shell = this.currentSpread + pulse + this.currentEnergy * 0.14 * Math.sin(time * 1.4 + point.phase);
        let filamentTension = 0;

        if (this.mode === 'speaking') {
            const speechCompression = (1 - this.currentEnergy) * (0.068 + point.filament * 0.038);
            const filamentWave = Math.max(0, Math.sin(time * 5.2 + point.filamentPhase + point.phase * 0.45));
            const filamentBurst = point.filament * (this.currentEnergy * 0.26 + this.transientBoost * 0.88) * (0.38 + filamentWave * 0.92);
            shell = shell - speechCompression + filamentBurst;
            filamentTension = point.filament * (0.26 + this.currentEnergy * 0.44 + this.transientBoost * 0.55);
        } else if (this.mode === 'idle') {
            const idleDrift = Math.sin(time * 1.55 + point.filamentPhase + point.phase * 0.3);
            shell -= 0.055 - point.filament * 0.016;
            shell += point.filament * 0.052 * idleDrift;
            shell += Math.sin(time * 0.9 + point.phase) * 0.012;
            filamentTension = point.filament * 0.08;
        } else if (this.mode === 'thinking') {
            const filamentWave = Math.max(0, Math.sin(time * 4.0 + point.filamentPhase));
            shell += point.filament * 0.05 * filamentWave;
            filamentTension = point.filament * 0.18;
        }

        let x = point.x * shell * this.baseRadius * point.depth;
        let y = point.y * shell * this.baseRadius * point.depth;
        let z = point.z * shell * this.baseRadius * point.depth;

        if (this.mode === 'idle') {
            const twist = (
                point.y * 0.92
                + Math.sin(time * 0.7 + point.phase) * 0.32
                + Math.sin(point.filamentPhase) * 0.22
            ) * (0.42 + point.filament * 0.7);
            const twistCos = Math.cos(twist);
            const twistSin = Math.sin(twist);
            const twistedX = x * twistCos - z * twistSin;
            const twistedZ = z * twistCos + x * twistSin;
            const curl = Math.sin(time * 1.08 + point.phase + point.filament * 3.2) * this.baseRadius * 0.028 * (0.4 + point.filament * 0.9);

            x = twistedX + Math.sin(point.y * Math.PI * 2.1 + time * 0.62) * curl;
            z = twistedZ + Math.cos(point.x * Math.PI * 1.8 + time * 0.56) * curl * 0.68;
            y *= 0.82 + point.filament * 0.12;
        }

        const wobbleScale = Math.max(0.22, 1 - filamentTension * 0.7);
        const wobble = Math.sin(time * 1.8 + point.twinkle) * jitterAmount * this.baseRadius * wobbleScale;
        x += wobble * 0.7;
        y += Math.cos(time * 1.4 + point.phase) * jitterAmount * this.baseRadius * 0.82 * wobbleScale;
        z += Math.sin(time * 1.1 + point.phase) * jitterAmount * this.baseRadius * 0.72 * wobbleScale;

        const cosY = Math.cos(this.rotationY);
        const sinY = Math.sin(this.rotationY);
        const x1 = x * cosY - z * sinY;
        const z1 = z * cosY + x * sinY;

        const cosX = Math.cos(this.rotationX);
        const sinX = Math.sin(this.rotationX);
        const y1 = y * cosX - z1 * sinX;
        const z2 = z1 * cosX + y * sinX;

        const cosZ = Math.cos(this.rotationZ);
        const sinZ = Math.sin(this.rotationZ);
        const x2 = x1 * cosZ - y1 * sinZ;
        const y2 = y1 * cosZ + x1 * sinZ;

        const perspective = this.focalLength / (this.focalLength - z2);

        return {
            sx: this.cx + x2 * perspective,
            sy: this.cy + y2 * perspective,
            z: z2,
            scale: perspective,
            size: point.size,
            filament: point.filament,
            alpha: Math.max(0.12, 0.3 + ((z2 / (this.baseRadius * 1.6)) + 1) * 0.25)
        };
    }

    drawBackground() {
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
    }

    drawShockwaves() {
        this.shockwaves = this.shockwaves.filter((wave) => wave.alpha > 0.01);

        for (const wave of this.shockwaves) {
            if (wave.radius > this.baseRadius * 1.05) {
                wave.alpha = 0;
                continue;
            }
            this.ctx.beginPath();
            this.ctx.strokeStyle = `rgba(92, 220, 255, ${wave.alpha})`;
            this.ctx.lineWidth = 0.9;
            this.ctx.arc(this.cx, this.cy, wave.radius, 0, Math.PI * 2);
            this.ctx.stroke();
            wave.radius += wave.speed;
            wave.alpha *= 0.95;
        }
    }

    drawScaffold(time, rise, palette = this.options.palette) {
        const shellRx = this.baseRadius * (0.92 + this.currentSpread * 0.24);
        const shellRy = this.baseRadius * (1.08 + this.currentSpread * 0.22);
        const idleLift = this.mode === 'idle' ? 0.082 : 0;
        const thinkingLift = this.mode === 'thinking' ? 0.054 : 0;
        const shellLift = idleLift + thinkingLift;
        const shellAlpha = 0.032 + shellLift + rise * 0.092;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';

        const ellipses = [
            {
                rx: shellRx * 0.94,
                ry: shellRy * 1.04,
                rotation: -0.08 + this.rotationZ * 0.12,
                start: -1.55,
                end: 1.55,
                stroke: this.mixRgba(palette.ember, palette.hot, 0.36 + rise * 0.3, shellAlpha),
                width: 0.82
            },
            {
                rx: shellRx * 1.03,
                ry: shellRy * 0.56,
                rotation: 0.22 + this.rotationX * 0.18,
                start: 0.18,
                end: Math.PI - 0.18,
                stroke: this.mixRgba(palette.hot, palette.spark, rise * 0.42, 0.026 + shellLift * 0.72 + rise * 0.07),
                width: 0.68
            },
            {
                rx: shellRx * 0.82,
                ry: shellRy * 0.96,
                rotation: -0.72 + this.rotationY * 0.08,
                start: -1.2,
                end: 2.05,
                stroke: this.mixRgba(palette.ember, palette.core, 0.34 + rise * 0.2, 0.024 + shellLift * 0.6 + rise * 0.058),
                width: 0.54
            },
            {
                rx: shellRx * 1.08,
                ry: shellRy * 0.44,
                rotation: -0.2 - this.rotationZ * 0.08,
                start: Math.PI + 0.2,
                end: Math.PI * 2 - 0.22,
                stroke: this.mixRgba(palette.hot, palette.spark, 0.56 + rise * 0.24, 0.012 + shellLift * 0.42 + rise * 0.04),
                width: 0.44
            }
        ];

        for (const ellipse of ellipses) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = ellipse.stroke;
            this.ctx.lineWidth = ellipse.width;
            this.ctx.ellipse(this.cx, this.cy, ellipse.rx, ellipse.ry, ellipse.rotation, ellipse.start, ellipse.end);
            this.ctx.stroke();
        }

        const sweepAlpha = 0.012 + shellLift * 0.45 + rise * 0.042;
        this.ctx.beginPath();
        this.ctx.strokeStyle = this.mixRgba(palette.ember, palette.hot, 0.42 + rise * 0.26, sweepAlpha);
        this.ctx.lineWidth = 0.36;
        this.ctx.moveTo(this.cx - shellRx * 0.82, this.cy - shellRy * 0.34);
        this.ctx.bezierCurveTo(
            this.cx - shellRx * 0.24,
            this.cy - shellRy * 0.88,
            this.cx + shellRx * 0.18,
            this.cy + shellRy * 0.86,
            this.cx + shellRx * 0.72,
            this.cy + shellRy * 0.18
        );
        this.ctx.stroke();

        this.ctx.restore();
    }

    drawThinkingGhostScaffold(time) {
        if (this.mode !== 'thinking') return;

        const ghostRx = this.baseRadius * (0.78 + this.currentSpread * 0.18);
        const ghostRy = this.baseRadius * (0.92 + this.currentSpread * 0.15);
        const ghostAlpha = 0.042 + this.currentEnergy * 0.11;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';

        const ellipses = [
            {
                rx: ghostRx * 0.96,
                ry: ghostRy * 0.88,
                rotation: 0.24 - this.rotationY * 0.16,
                start: -1.38,
                end: 1.84,
                stroke: this.mixRgba(this.options.palette.ember, this.options.palette.core, 0.24, ghostAlpha),
                width: 0.42
            },
            {
                rx: ghostRx * 1.08,
                ry: ghostRy * 0.52,
                rotation: -0.34 - this.rotationZ * 0.2,
                start: 0.24,
                end: Math.PI - 0.08,
                stroke: this.mixRgba(this.options.palette.ember, this.options.palette.hot, 0.28, 0.01 + this.currentEnergy * 0.04),
                width: 0.38
            },
            {
                rx: ghostRx * 0.72,
                ry: ghostRy * 1.04,
                rotation: 0.62 - this.rotationX * 0.18,
                start: Math.PI + 0.08,
                end: Math.PI * 2 - 0.18,
                stroke: this.mixRgba(this.options.palette.ember, this.options.palette.core, 0.18, 0.008 + this.currentEnergy * 0.032),
                width: 0.34
            }
        ];

        for (const ellipse of ellipses) {
            this.ctx.beginPath();
            this.ctx.strokeStyle = ellipse.stroke;
            this.ctx.lineWidth = ellipse.width;
            this.ctx.ellipse(this.cx, this.cy, ellipse.rx, ellipse.ry, ellipse.rotation, ellipse.start, ellipse.end);
            this.ctx.stroke();
        }

        this.ctx.beginPath();
        this.ctx.strokeStyle = this.mixRgba(this.options.palette.ember, this.options.palette.hot, 0.16, 0.01 + this.currentEnergy * 0.03);
        this.ctx.lineWidth = 0.3;
        this.ctx.moveTo(this.cx - ghostRx * 0.72, this.cy + ghostRy * 0.2);
        this.ctx.bezierCurveTo(
            this.cx - ghostRx * 0.16,
            this.cy - ghostRy * 0.84,
            this.cx + ghostRx * 0.12,
            this.cy + ghostRy * 0.82,
            this.cx + ghostRx * 0.66,
            this.cy - ghostRy * 0.08
        );
        this.ctx.stroke();

        this.ctx.restore();
    }

    drawCore(time, rise, palette = this.options.palette) {
        const idleLift = this.mode === 'idle' ? 0.068 : 0;
        const thinkingLift = this.mode === 'thinking' ? 0.038 : 0;
        const thinkingTighten = this.mode === 'thinking' ? 0.84 : 1;
        const coreRadius = this.baseRadius * (0.016 + this.currentSpread * 0.01 + this.currentEnergy * 0.032) * thinkingTighten;
        const coreGradient = this.ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, coreRadius * 2.4);
        coreGradient.addColorStop(0, this.rgba(palette.core, 0.12 + idleLift * 0.58 + thinkingLift * 0.5 + (this.mode === 'thinking' ? this.currentEnergy * 0.06 : rise * 0.16)));
        coreGradient.addColorStop(0.18, this.mixRgba(this.mode === 'thinking' ? this.options.palette.ember : palette.hot, palette.core, this.mode === 'thinking' ? 0.18 : 0.4, 0.06 + idleLift * 0.44 + thinkingLift * 0.42 + (this.mode === 'thinking' ? this.currentEnergy * 0.05 : rise * 0.12)));
        coreGradient.addColorStop(0.5, this.rgba(this.mode === 'thinking' ? this.options.palette.ember : palette.ember, 0.02 + idleLift * 0.22 + thinkingLift * 0.18 + (this.mode === 'thinking' ? this.currentEnergy * 0.03 : rise * 0.05)));
        coreGradient.addColorStop(1, this.rgba(this.mode === 'thinking' ? this.options.palette.ember : palette.ember, 0));

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';
        this.ctx.fillStyle = coreGradient;
        this.ctx.beginPath();
        this.ctx.arc(this.cx, this.cy, coreRadius * 2.4, 0, Math.PI * 2);
        this.ctx.fill();

        const ringCount = this.mode === 'speaking' && rise > 0.36 ? 1 : 0;
        for (let i = 0; i < ringCount; i += 1) {
            const ringRadius = coreRadius * (1.08 + i * 0.18 + Math.sin(time * (1.8 + i * 0.3)) * 0.02);
            this.ctx.beginPath();
            this.ctx.strokeStyle = this.mixRgba(palette.ember, palette.spark, rise * 0.34, 0.01 + rise * 0.04);
            this.ctx.lineWidth = 0.46;
            this.ctx.arc(this.cx, this.cy, ringRadius, time * 0.3 + i, time * 0.3 + i + Math.PI * 1.35);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    drawLightBeads(projected, rise, palette = this.options.palette) {
        if (!this.lightBeads.length) return;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        for (const pulse of this.lightBeads) {
            const points = pulse.path.map((index) => projected[index]).filter(Boolean);
            if (points.length < 2) continue;
            const isIdlePulse = pulse.channel === 'idle';
            const isThinkingPulse = pulse.channel === 'thinking';

            const segments = [];
            let totalLength = 0;

            for (let i = 0; i < points.length - 1; i += 1) {
                const from = points[i];
                const to = points[i + 1];
                const length = Math.hypot(to.sx - from.sx, to.sy - from.sy);
                if (length < 0.5) continue;
                segments.push({
                    from,
                    to,
                    length,
                    start: totalLength,
                    end: totalLength + length
                });
                totalLength += length;
            }

            if (totalLength < 22) continue;

            const headDistance = totalLength * (pulse.reverse ? 1 - pulse.progress : pulse.progress);
            const tailDistance = Math.max(totalLength * pulse.tail, this.baseRadius * 0.08);

            for (const segment of segments) {
                const visibleStart = Math.max(segment.start, headDistance - tailDistance);
                const visibleEnd = Math.min(segment.end, headDistance);
                if (visibleEnd <= visibleStart) continue;

                const startT = (visibleStart - segment.start) / segment.length;
                const endT = (visibleEnd - segment.start) / segment.length;
                const sx = segment.from.sx + (segment.to.sx - segment.from.sx) * startT;
                const sy = segment.from.sy + (segment.to.sy - segment.from.sy) * startT;
                const ex = segment.from.sx + (segment.to.sx - segment.from.sx) * endT;
                const ey = segment.from.sy + (segment.to.sy - segment.from.sy) * endT;
                const trailStart = Math.max(0, 1 - (headDistance - visibleStart) / tailDistance);
                const trailEnd = Math.max(0, 1 - (headDistance - visibleEnd) / tailDistance);
                const gradient = this.ctx.createLinearGradient(sx, sy, ex, ey);

                if (isIdlePulse) {
                    gradient.addColorStop(0, this.mixRgba(
                        this.options.palette.ember,
                        this.options.palette.hot,
                        0.18 + pulse.mix,
                        pulse.alpha * (0.06 + trailStart * 0.16)
                    ));
                    gradient.addColorStop(1, this.mixRgba(
                        this.options.palette.hot,
                        this.options.palette.core,
                        0.26 + pulse.mix,
                        pulse.alpha * (0.14 + trailEnd * 0.34)
                    ));
                } else if (isThinkingPulse) {
                    gradient.addColorStop(0, this.mixRgba(
                        this.options.palette.ember,
                        this.options.palette.hot,
                        0.18 + pulse.mix,
                        pulse.alpha * (0.05 + trailStart * 0.14)
                    ));
                    gradient.addColorStop(1, this.mixRgba(
                        this.options.palette.hot,
                        this.options.palette.core,
                        0.34 + pulse.mix,
                        pulse.alpha * (0.14 + trailEnd * 0.42)
                    ));
                } else {
                    gradient.addColorStop(0, this.mixRgba(
                        palette.ember,
                        palette.hot,
                        pulse.mix + rise * 0.12,
                        pulse.alpha * (0.04 + trailStart * 0.2)
                    ));
                    gradient.addColorStop(1, this.mixRgba(
                        palette.hot,
                        palette.spark,
                        0.52 + rise * 0.22,
                        pulse.alpha * (0.16 + trailEnd * 0.72)
                    ));
                }

                this.ctx.strokeStyle = gradient;
                this.ctx.lineWidth = isIdlePulse
                    ? 0.34 + pulse.width * (0.54 + trailEnd * 0.26)
                    : isThinkingPulse
                        ? 0.42 + pulse.width * (0.56 + trailEnd * 0.34)
                        : 0.44 + pulse.width * (0.62 + trailEnd * 0.5);
                this.ctx.beginPath();
                this.ctx.moveTo(sx, sy);
                this.ctx.lineTo(ex, ey);
                this.ctx.stroke();
            }

            if (headDistance <= 0) continue;

            let headPoint = null;
            for (const segment of segments) {
                if (headDistance > segment.end) continue;
                const t = Math.max(0, Math.min(1, (headDistance - segment.start) / segment.length));
                headPoint = {
                    x: segment.from.sx + (segment.to.sx - segment.from.sx) * t,
                    y: segment.from.sy + (segment.to.sy - segment.from.sy) * t
                };
                break;
            }

            if (!headPoint) continue;

            this.ctx.shadowColor = isIdlePulse
                    ? this.mixRgba(this.options.palette.hot, this.options.palette.core, 0.18, 0.18 + pulse.alpha * 0.28)
                    : isThinkingPulse
                        ? this.mixRgba(this.options.palette.hot, this.options.palette.core, 0.24, 0.18 + pulse.alpha * 0.3)
                    : this.mixRgba(palette.hot, palette.spark, 0.66 + rise * 0.18, 0.38 + pulse.alpha * 0.42);
            this.ctx.shadowBlur = isIdlePulse
                ? 3.6 + pulse.width * 2.8
                : isThinkingPulse
                    ? 4.8 + pulse.width * 3.2
                    : 6 + pulse.width * 4 + rise * 4;
            this.ctx.beginPath();
            this.ctx.fillStyle = isIdlePulse
                ? this.mixRgba(this.options.palette.core, this.options.palette.hot, 0.14, 0.34 + pulse.alpha * 0.34)
                : isThinkingPulse
                    ? this.mixRgba(this.options.palette.core, this.options.palette.hot, 0.18, 0.34 + pulse.alpha * 0.34)
                    : this.mixRgba(palette.core, palette.spark, 0.62 + rise * 0.22, 0.72 + pulse.alpha * 0.2);
            this.ctx.arc(
                headPoint.x,
                headPoint.y,
                (isIdlePulse ? 0.92 : isThinkingPulse ? 1.02 : 1.05)
                    + pulse.width * (isIdlePulse ? 0.48 : isThinkingPulse ? 0.54 : 0.72)
                    + rise * (isThinkingPulse ? 0.12 : isIdlePulse ? 0.04 : 0.34),
                0,
                Math.PI * 2
            );
            this.ctx.fill();
        }

        this.ctx.shadowBlur = 0;
        this.ctx.restore();
    }

    drawNodeFlashes(projected) {
        if (!this.nodeFlashes.length) return;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';

        for (const flash of this.nodeFlashes) {
            const point = projected[flash.index];
            if (!point) continue;

            const radius = flash.radius * (0.72 + point.scale * 0.28);
            const gradient = this.ctx.createRadialGradient(point.sx, point.sy, 0, point.sx, point.sy, radius * 4.6);
            gradient.addColorStop(0, this.mixRgba(this.options.palette.core, this.options.palette.hot, 0.16, flash.alpha * 0.9));
            gradient.addColorStop(0.42, this.mixRgba(this.options.palette.ember, this.options.palette.hot, flash.mix, flash.alpha * 0.34));
            gradient.addColorStop(1, this.rgba(this.options.palette.ember, 0));

            this.ctx.beginPath();
            this.ctx.fillStyle = gradient;
            this.ctx.arc(point.sx, point.sy, radius * 4.6, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.beginPath();
            this.ctx.fillStyle = this.mixRgba(this.options.palette.core, this.options.palette.hot, 0.12, flash.alpha * 0.82);
            this.ctx.arc(point.sx, point.sy, radius, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.restore();
    }

    draw(time) {
        const rise = Math.min(1, this.currentEnergy * 0.9 + this.transientBoost * 2.5);
        const speakingPalette = this.mode === 'speaking'
            ? this.getSpeakingPalette(rise)
            : this.options.palette;

        this.drawBackground();
        this.drawScaffold(time, rise, speakingPalette);
        this.drawThinkingGhostScaffold(time);
        this.drawCore(time, rise, speakingPalette);

        const projected = this.particles.map((particle) => this.rotatePoint(particle, time));
        const idleLift = this.mode === 'idle' ? 0.34 : 0;
        const thinkingLift = this.mode === 'thinking' ? 0.3 : 0;

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';

        for (let i = 0; i < this.particles.length; i += 1) {
            const from = projected[i];
            const links = this.particles[i].links;

            for (const linkIndex of links) {
                if (linkIndex < i) continue;
                const to = projected[linkIndex];
                const distance = Math.hypot(from.sx - to.sx, from.sy - to.sy);
                const maxDistance = this.baseRadius * (this.mode === 'idle'
                    ? 0.42 + this.currentSpread * 0.46
                    : this.mode === 'thinking'
                        ? 0.34 + this.currentSpread * 0.38
                        : 0.22 + this.currentSpread * 0.26);
                if (distance > maxDistance) continue;

                const filamentMix = Math.max(from.filament || 0, to.filament || 0);
                const baseAlpha = this.currentLineAlpha * (1 - distance / maxDistance) * Math.min(from.alpha, to.alpha) * (0.62 + rise * 1.3);
                const stringBoost = this.mode === 'speaking'
                    ? 1.02 + filamentMix * (1.4 + rise * 2.2)
                    : (this.mode === 'idle'
                        ? 1.58 + filamentMix * 1.56
                        : 1.44 + filamentMix * 1.18);
                const alpha = Math.min(0.94, baseAlpha * stringBoost);
                this.ctx.strokeStyle = this.mixRgba(
                    this.mode === 'speaking' ? speakingPalette.ember : this.options.palette.ember,
                    filamentMix > 0.62
                        ? (this.mode === 'thinking' ? this.options.palette.core : speakingPalette.spark)
                        : (this.mode === 'speaking' ? speakingPalette.hot : this.options.palette.hot),
                    this.mode === 'thinking' ? 0.34 + this.currentEnergy * 0.28 : 0.42 + rise * 0.46,
                    alpha
                );
                this.ctx.lineWidth = this.mode === 'idle'
                    ? 0.34 + filamentMix * 0.3
                    : this.mode === 'thinking'
                        ? 0.38 + filamentMix * 0.3 + this.currentEnergy * 0.18
                        : 0.24 + filamentMix * (0.18 + rise * 0.28) + this.currentEnergy * 0.16 + rise * 0.12;
                this.ctx.beginPath();
                this.ctx.moveTo(from.sx, from.sy);
                this.ctx.lineTo(to.sx, to.sy);
                this.ctx.stroke();
            }
        }

        this.drawLightBeads(projected, rise, speakingPalette);
        this.drawNodeFlashes(projected);

        projected.sort((a, b) => a.z - b.z);

        for (const point of projected) {
            const radius = point.size * (0.34 + point.scale * 0.42) * (0.88 + this.currentEnergy * 0.2 + point.filament * this.currentEnergy * 0.14);
            const pointAlpha = point.alpha * (0.5 + idleLift + thinkingLift + rise * 0.54 + point.filament * rise * 0.18);

            this.ctx.beginPath();
            this.ctx.fillStyle = this.mixRgba(
                this.mode === 'speaking' ? speakingPalette.core : this.options.palette.core,
                point.filament > 0.68
                    ? (this.mode === 'thinking' ? this.options.palette.hot : speakingPalette.spark)
                    : (this.mode === 'speaking' ? speakingPalette.hot : this.options.palette.hot),
                this.mode === 'thinking'
                    ? 0.04 + this.currentEnergy * 0.12
                    : rise * (0.12 + point.filament * 0.16),
                pointAlpha
            );
            this.ctx.shadowBlur = 0;
            this.ctx.arc(point.sx, point.sy, radius, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.shadowColor = this.mode === 'thinking'
            ? this.mixRgba(this.options.palette.ember, this.options.palette.hot, 0.28, 0.18 + this.currentEnergy * 0.1)
            : this.mixRgba(speakingPalette.ember, speakingPalette.hot, 0.42 + rise * 0.26, 0.18 + rise * 0.1);
        for (let i = this.glowStride - 1; i < projected.length; i += this.glowStride) {
            const point = projected[i];
            const glowRadius = point.size * (0.24 + point.scale * 0.18) * (0.72 + this.currentEnergy * 0.12);
            this.ctx.beginPath();
            this.ctx.fillStyle = this.mode === 'thinking'
                ? this.mixRgba(this.options.palette.ember, this.options.palette.hot, 0.22, point.alpha * (0.05 + this.currentEnergy * 0.11))
                : this.mixRgba(speakingPalette.hot, speakingPalette.spark, rise * 0.3, point.alpha * (0.02 + idleLift * 0.16 + rise * 0.08));
            this.ctx.shadowBlur = this.mode === 'thinking'
                ? 2.1 + point.scale * 1.1 + this.currentEnergy * 3.6
                : 0.8 + point.scale * 0.8 + idleLift * 3.4 + rise * 3.2;
            this.ctx.arc(point.sx, point.sy, glowRadius, 0, Math.PI * 2);
            this.ctx.fill();
        }
        this.ctx.shadowBlur = 0;

        this.ctx.restore();
    }

    tick(now) {
        const elapsed = Math.min(42, now - this.lastFrame);
        const time = now * 0.001;
        this.lastFrame = now;

        this.speakingColorProfile.force = this.lerp(this.speakingColorProfile.force, this.targetSpeakingColorProfile.force, 0.1);
        this.speakingColorProfile.warmth = this.lerp(this.speakingColorProfile.warmth, this.targetSpeakingColorProfile.warmth, 0.1);
        this.speakingColorProfile.heaviness = this.lerp(this.speakingColorProfile.heaviness, this.targetSpeakingColorProfile.heaviness, 0.1);
        this.speakingColorProfile.wonder = this.lerp(this.speakingColorProfile.wonder, this.targetSpeakingColorProfile.wonder, 0.1);
        this.speakingColorProfile.tension = this.lerp(this.speakingColorProfile.tension, this.targetSpeakingColorProfile.tension, 0.1);

        const sampledEnergy = this.getEnergy(now);
        this.currentEnergy = this.lerp(this.currentEnergy, sampledEnergy, sampledEnergy > this.currentEnergy ? 0.42 : 0.24);
        if (this.mode === 'speaking' && this.transientBoost > 0.035 && now - this.lastPulseAt > 48) {
            this.spawnLightBeads(Math.min(1, this.currentEnergy * 0.7 + this.transientBoost * 2.6));
            this.lastPulseAt = now;
        }
        if (this.mode === 'idle') {
            const activeIdleBeads = this.lightBeads.filter((pulse) => pulse.channel === 'idle').length;
            const desiredIdleBeads = 2 + (Math.sin(time * 0.9) > 0.4 ? 1 : 0);

            if (activeIdleBeads < desiredIdleBeads && now - this.lastIdleProbeAt > 280) {
                this.spawnIdleProbe();
                this.lastIdleProbeAt = now;
            }
        }
        if (this.mode === 'thinking') {
            const activeThinkingBeads = this.lightBeads.filter((pulse) => pulse.channel === 'thinking').length;
            const desiredThinkingBeads = 4
                + (Math.sin(time * 1.8) > 0.18 ? 1 : 0)
                + (Math.cos(time * 1.14) > 0.6 ? 1 : 0);

            if (activeThinkingBeads < desiredThinkingBeads && now - this.lastThinkingProbeAt > 90) {
                this.spawnThinkingProbe();
                this.lastThinkingProbeAt = now;
            }

            if (this.intersectionNodes.length && now - this.lastNodeFlashAt > 150 && Math.random() < 0.22 + this.currentEnergy * 0.1) {
                this.spawnNodeFlash();
                this.lastNodeFlashAt = now;
            }
        }
        this.updateLightBeads(elapsed);
        this.updateNodeFlashes(elapsed);

        const targets = {
            idle: {
                spread: 0.43,
                spin: 0.0024,
                lineAlpha: 0.17,
                jitter: 0.02,
                halo: 0.22
            },
            thinking: {
                spread: 0.44,
                spin: 0.124,
                lineAlpha: 0.19,
                jitter: 0.034,
                halo: 0.28
            },
            speaking: {
                spread: 0.24 + this.currentEnergy * 0.62 + this.transientBoost * 0.18,
                spin: 0.009 + this.currentEnergy * 0.02,
                lineAlpha: 0.06 + this.currentEnergy * 0.28 + this.transientBoost * 0.08,
                jitter: 0.02 + this.currentEnergy * 0.08,
                halo: 0.16 + this.currentEnergy * 0.18
            }
        }[this.mode];

        this.currentSpread = this.lerp(this.currentSpread, targets.spread, targets.spread > this.currentSpread ? 0.14 : 0.22);
        this.currentSpin = this.lerp(this.currentSpin, targets.spin, targets.spin > this.currentSpin ? 0.12 : 0.18);
        this.currentLineAlpha = this.lerp(this.currentLineAlpha, targets.lineAlpha, targets.lineAlpha > this.currentLineAlpha ? 0.14 : 0.24);
        this.currentJitter = this.lerp(this.currentJitter, targets.jitter, targets.jitter > this.currentJitter ? 0.12 : 0.2);
        this.currentHalo = this.lerp(this.currentHalo, targets.halo, targets.halo > this.currentHalo ? 0.1 : 0.18);

        const spinMultiplier = this.mode === 'thinking' ? 2.4 : 1;
        this.rotationY += this.currentSpin * (elapsed / 16.666) * spinMultiplier;
        this.rotationX = Math.sin(time * (this.mode === 'thinking' ? 3.8 : 1.2)) * (0.13 + this.currentEnergy * 0.11);
        this.rotationZ = Math.cos(time * (this.mode === 'thinking' ? 3.1 : 0.7)) * 0.1;

        this.draw(time);
    }

    loop(now) {
        if (this.lastRenderTime && now - this.lastRenderTime < (1000 / this.options.targetFps)) {
            this.frameId = requestAnimationFrame(this.loop);
            return;
        }
        this.lastRenderTime = now;
        this.tick(now);
        this.frameId = requestAnimationFrame(this.loop);
    }

    start() {
        if (this.frameId) return;
        this.lastFrame = performance.now();
        this.frameId = requestAnimationFrame(this.loop);
    }

    stop() {
        if (!this.frameId) return;
        cancelAnimationFrame(this.frameId);
        this.frameId = null;
    }

    destroy() {
        this.stop();
        this.disconnectAudio();

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}

window.MichaelParticleBurst = MichaelParticleBurst;
