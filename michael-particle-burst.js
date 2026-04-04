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
                core: '#ffd36b',
                hot: '#ff9f1c',
                ember: '#ff6b00',
                spark: '#fff3bf',
                smoke: 'rgba(255, 170, 60, 0.12)'
            }
        };

        this.mode = 'idle';
        this.manualEnergy = null;
        this.currentEnergy = 0.12;
        this.currentSpread = 0.34;
        this.currentSpin = 0.0025;
        this.currentLineAlpha = 0.16;
        this.currentJitter = 0.18;
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
        this.cx = this.width / 2;
        this.cy = this.height / 2;
        this.baseRadius = Math.min(this.width, this.height) * 0.29;
        this.focalLength = Math.min(this.width, this.height) * 1.3;
    }

    setMode(mode) {
        if (!['idle', 'thinking', 'speaking'].includes(mode)) return;
        if (mode !== this.mode) {
            this.shockwaves.push({
                radius: this.baseRadius * 0.22,
                alpha: mode === 'thinking' ? 0.16 : 0.22,
                speed: mode === 'thinking' ? 2.4 : 2.9
            });
        }
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
        } else if (this.mode === 'thinking') {
            const filamentWave = Math.max(0, Math.sin(time * 4.0 + point.filamentPhase));
            shell += point.filament * 0.05 * filamentWave;
            filamentTension = point.filament * 0.18;
        }

        let x = point.x * shell * this.baseRadius * point.depth;
        let y = point.y * shell * this.baseRadius * point.depth;
        let z = point.z * shell * this.baseRadius * point.depth;

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
            this.ctx.strokeStyle = `rgba(255, 189, 86, ${wave.alpha})`;
            this.ctx.lineWidth = 0.9;
            this.ctx.arc(this.cx, this.cy, wave.radius, 0, Math.PI * 2);
            this.ctx.stroke();
            wave.radius += wave.speed;
            wave.alpha *= 0.95;
        }
    }

    drawCore(time) {
        const coreRadius = this.baseRadius * (0.09 + this.currentSpread * 0.05 + this.currentEnergy * 0.09);
        const coreGradient = this.ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, coreRadius * 2.4);
        coreGradient.addColorStop(0, 'rgba(255, 245, 198, 0.72)');
        coreGradient.addColorStop(0.18, 'rgba(255, 188, 96, 0.42)');
        coreGradient.addColorStop(0.5, 'rgba(255, 110, 20, 0.12)');
        coreGradient.addColorStop(1, 'rgba(255, 110, 20, 0)');

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';
        this.ctx.fillStyle = coreGradient;
        this.ctx.beginPath();
        this.ctx.arc(this.cx, this.cy, coreRadius * 2.4, 0, Math.PI * 2);
        this.ctx.fill();

        const ringCount = this.mode === 'thinking' ? 2 : 1;
        for (let i = 0; i < ringCount; i += 1) {
            const ringRadius = coreRadius * (1.08 + i * 0.18 + Math.sin(time * (1.8 + i * 0.3)) * 0.02);
            this.ctx.beginPath();
            this.ctx.strokeStyle = `rgba(255, 180, 72, ${0.028 + i * 0.016 + this.currentEnergy * 0.022})`;
            this.ctx.lineWidth = i === 0 ? 0.72 : 0.42;
            this.ctx.arc(this.cx, this.cy, ringRadius, time * 0.3 + i, time * 0.3 + i + Math.PI * 1.35);
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    draw(time) {
        this.drawBackground();
        this.drawShockwaves();
        this.drawCore(time);

        const projected = this.particles.map((particle) => this.rotatePoint(particle, time));

        this.ctx.save();
        this.ctx.globalCompositeOperation = 'screen';

        for (let i = 0; i < this.particles.length; i += 1) {
            const from = projected[i];
            const links = this.particles[i].links;

            for (const linkIndex of links) {
                if (linkIndex < i) continue;
                const to = projected[linkIndex];
                const distance = Math.hypot(from.sx - to.sx, from.sy - to.sy);
                const maxDistance = this.baseRadius * (0.22 + this.currentSpread * 0.26);
                if (distance > maxDistance) continue;

                const alpha = this.currentLineAlpha * (1 - distance / maxDistance) * Math.min(from.alpha, to.alpha);
                this.ctx.strokeStyle = `rgba(255, 190, 92, ${alpha})`;
                this.ctx.lineWidth = 0.34 + this.currentEnergy * 0.28;
                this.ctx.beginPath();
                this.ctx.moveTo(from.sx, from.sy);
                this.ctx.lineTo(to.sx, to.sy);
                this.ctx.stroke();
            }
        }

        projected.sort((a, b) => a.z - b.z);

        for (const point of projected) {
            const radius = point.size * (0.34 + point.scale * 0.42) * (0.88 + this.currentEnergy * 0.2 + point.filament * this.currentEnergy * 0.14);

            this.ctx.beginPath();
            this.ctx.fillStyle = `rgba(255, 248, 224, ${point.alpha * (0.7 + point.filament * 0.14)})`;
            this.ctx.shadowBlur = 0;
            this.ctx.arc(point.sx, point.sy, radius, 0, Math.PI * 2);
            this.ctx.fill();
        }

        this.ctx.shadowColor = 'rgba(255, 160, 64, 0.34)';
        for (let i = this.glowStride - 1; i < projected.length; i += this.glowStride) {
            const point = projected[i];
            const glowRadius = point.size * (0.24 + point.scale * 0.18) * (0.72 + this.currentEnergy * 0.12);
            this.ctx.beginPath();
            this.ctx.fillStyle = `rgba(255, 214, 156, ${point.alpha * 0.14})`;
            this.ctx.shadowBlur = 1.8 + point.scale * 1.8 + this.currentEnergy * 2.2;
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

        const sampledEnergy = this.getEnergy(now);
        this.currentEnergy = this.lerp(this.currentEnergy, sampledEnergy, sampledEnergy > this.currentEnergy ? 0.34 : 0.16);

        const targets = {
            idle: {
                spread: 0.165,
                spin: 0.0024,
                lineAlpha: 0.1,
                jitter: 0.038,
                halo: 0.14
            },
            thinking: {
                spread: 0.265,
                spin: 0.092,
                lineAlpha: 0.19,
                jitter: 0.11,
                halo: 0.22
            },
            speaking: {
                spread: 0.094 + this.currentEnergy * 0.39,
                spin: 0.009 + this.currentEnergy * 0.02,
                lineAlpha: 0.06 + this.currentEnergy * 0.22,
                jitter: 0.024 + this.currentEnergy * 0.14,
                halo: 0.16 + this.currentEnergy * 0.18
            }
        }[this.mode];

        this.currentSpread = this.lerp(this.currentSpread, targets.spread, 0.08);
        this.currentSpin = this.lerp(this.currentSpin, targets.spin, 0.08);
        this.currentLineAlpha = this.lerp(this.currentLineAlpha, targets.lineAlpha, 0.08);
        this.currentJitter = this.lerp(this.currentJitter, targets.jitter, 0.08);
        this.currentHalo = this.lerp(this.currentHalo, targets.halo, 0.08);

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
