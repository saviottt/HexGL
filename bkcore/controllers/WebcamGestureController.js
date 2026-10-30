/**
 * bkcore.controllers.WebcamGestureController
 * Real-time MediaPipe Hands gesture controller & futuristic HUD for HexGL.
 *
 * Control scheme (controlType == 5):
 *   - Both hands open (fingers extended) → Accelerate (forward thrust)
 *   - Left thumb folded inward           → Steer Left
 *   - Right thumb folded inward          → Steer Right
 *   - Both thumbs extended               → Drive Straight
 *   - Hands removed / closed             → Coast / Stop thrust
 *
 * Non-destructive: all existing keyboard/touch/gamepad/leap handlers in
 * ShipControls.js remain fully intact and active at all times.
 */
var bkcore = bkcore || {};
bkcore.controllers = bkcore.controllers || {};

(function() {
  'use strict';

  /* ─── Geometry helpers ──────────────────────────────────────────────── */

  function dist2D(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function angleBetween(a, b, c) {
    var abx = a.x - b.x;
    var aby = a.y - b.y;
    var cbx = c.x - b.x;
    var cby = c.y - b.y;
    var dot = abx * cbx + aby * cby;
    var mag = Math.sqrt(abx * abx + aby * aby) * Math.sqrt(cbx * cbx + cby * cby);
    if (mag < 1e-6) return 180;
    var cos = Math.max(-1, Math.min(1, dot / mag));
    return Math.acos(cos) * (180 / Math.PI);
  }

  /* ─── Constructor ───────────────────────────────────────────────────── */

  function WebcamGestureController(options) {
    options = options || {};
    this.mode = options.initialMode || 'keyboard'; // 'keyboard' | 'webcam'
    this.onModeChange = options.onModeChange || null;

    // Camera & MediaPipe state
    this.stream = null;
    this.hands = null;
    this.isCameraRunning = false;
    this.isProcessingFrame = false;
    this.mediapipeLoaded = false;
    this.mediapipeFailed = false;
    this.permissionStatus = 'Not Requested';
    this.hasShownInstructions = false;
    this.frameTimer = null;

    this.autoThrust = true; // Auto-cruise keeps ship moving forward in webcam mode

    // Raw & debounced gesture states
    this.state = {
      leftHandDetected: false,
      rightHandDetected: false,
      bothHandsDetected: false,
      leftThumbFolded: false,
      rightThumbFolded: false,
      leftHandOpen: false,
      rightHandOpen: false,
      accelerate: true,
      brake: false,
      steerLeft: false,
      steerRight: false,
      analogSteer: 0,
      steerValue: 0,   // Smoothed analogue: -1 (hard left) … 0 … +1 (hard right)
      gestureName: 'AUTO-CRUISE READY',
      steeringLabel: 'STRAIGHT'
    };

    // Landmark EMA smoothing
    this.smoothedLandmarks = { Left: null, Right: null };
    this.landmarkAlpha = 0.65;  // Responsive smoothing

    // Steering analogue smooth-blend rate per second
    this.steerSmoothing = 12.0;

    // Debounce / stable-frame buffers
    this.candidateSteer = 'STRAIGHT';
    this.candidateSteerFrames = 0;
    this.committedSteer = 'STRAIGHT';
    this.lastSteerChangeTime = 0;

    this.candidateAccel = true;
    this.candidateAccelFrames = 0;
    this.committedAccel = true;
    this.lastAccelChangeTime = 0;

    this.STABLE_FRAMES_REQUIRED = 1;   // Fast reaction time
    this.STATE_COOLDOWN_MS = 40;       // Low cooldown for fluid responsiveness

    this.buildUI();
    this.bindLifecycleEvents();
  }

  /* ─── UI construction ───────────────────────────────────────────────── */

  WebcamGestureController.prototype.buildUI = function() {
    if (document.getElementById('hexgl-webcam-hud')) return;

    var hud = document.createElement('div');
    hud.id = 'hexgl-webcam-hud';
    hud.innerHTML = [
      '<div class="hex-hud-header">',
      '  <div class="hex-hud-title">',
      '    <span id="hex-cam-dot" class="hex-hud-title-dot"></span>',
      '    <span>NEURAL GESTURE LINK</span>',
      '  </div>',
      '  <div class="hex-hud-header-actions">',
      '    <button id="hex-btn-guide" class="hex-icon-btn" title="Gesture Instructions">?</button>',
      '    <button id="hex-btn-minimize" class="hex-icon-btn" title="Minimize Panel">_</button>',
      '  </div>',
      '</div>',
      '<div class="hex-hud-body">',
      '  <div class="hex-mode-switch">',
      '    <button id="hex-mode-kb" class="hex-mode-btn active">Keyboard Mode</button>',
      '    <button id="hex-mode-cam" class="hex-mode-btn">Webcam Gesture</button>',
      '  </div>',
      '  <div class="hex-cam-viewport">',
      '    <video id="hex-webcam-video" playsinline muted></video>',
      '    <canvas id="hex-webcam-canvas" width="320" height="180"></canvas>',
      '    <div id="hex-cam-placeholder" class="hex-cam-placeholder">',
      '      <span id="hex-cam-placeholder-text">CAMERA OFFLINE<br><small>Enable camera or select Webcam Mode</small></span>',
      '    </div>',
      '  </div>',
      '  <div class="hex-cam-controls">',
      '    <button id="hex-btn-enable-cam" class="hex-action-btn hex-btn-enable">Enable Camera</button>',
      '    <button id="hex-btn-disable-cam" class="hex-action-btn hex-btn-disable" disabled>Disable Camera</button>',
      '    <button id="hex-btn-autothrust" class="hex-action-btn hex-btn-autothrust" style="grid-column: span 2; margin-top: 4px; background: rgba(0,240,255,0.18); border: 1px solid #00f0ff; color: #00f0ff; font-size: 11px; padding: 5px; cursor: pointer; text-transform: uppercase; font-weight: bold; border-radius: 4px;">Auto-Cruise: ON</button>',
      '  </div>',
      '  <div class="hex-status-grid">',
      '    <div class="hex-status-item">',
      '      <span class="hex-status-label">Camera Permission</span>',
      '      <span id="hex-status-perm" class="hex-status-value">Standby</span>',
      '    </div>',
      '    <div class="hex-status-item">',
      '      <span class="hex-status-label">Hand Detection</span>',
      '      <span id="hex-status-hands" class="hex-status-value">0 Hands</span>',
      '    </div>',
      '  </div>',
      '  <div class="hex-hands-row">',
      '    <div id="hex-ind-left" class="hex-hand-pill">',
      '      <span>L-HAND</span><span id="hex-ind-left-state">OFF</span>',
      '    </div>',
      '    <div id="hex-ind-right" class="hex-hand-pill">',
      '      <span>R-HAND</span><span id="hex-ind-right-state">OFF</span>',
      '    </div>',
      '  </div>',
      '  <div class="hex-telemetry-banner">',
      '    <span class="hex-status-label">Current Gesture</span>',
      '    <span id="hex-status-gesture" class="hex-gesture-badge">KEYBOARD ACTIVE</span>',
      '  </div>',
      '  <div class="hex-steer-meter-wrap">',
      '    <div class="hex-steer-labels">',
      '      <span id="hex-dir-left">&lt;&lt; LEFT</span>',
      '      <span id="hex-dir-center" class="active-dir">STRAIGHT</span>',
      '      <span id="hex-dir-right">RIGHT &gt;&gt;</span>',
      '    </div>',
      '    <div class="hex-steer-track">',
      '      <div class="hex-steer-center-mark"></div>',
      '      <div id="hex-steer-fill"></div>',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(hud);

    /* ── Gesture Instructions Modal ─────────────────────────────────── */
    var modal = document.createElement('div');
    modal.id = 'hexgl-gesture-modal';
    modal.className = 'hidden';
    modal.innerHTML = [
      '<div class="hex-modal-card">',
      '  <div class="hex-modal-header">',
      '    <h2>Webcam Hand Gesture Flight System</h2>',
      '    <button id="hex-modal-close-x" class="hex-icon-btn">X</button>',
      '  </div>',
      '  <div class="hex-modal-content">',
      '    <p class="hex-modal-subtitle">Position both hands clearly in front of your webcam. The system tracks your 21 hand landmarks in real time:</p>',
      '    <div class="hex-gesture-cards">',
      '      <div class="hex-gesture-card">',
      '        <svg class="hex-gesture-svg" viewBox="0 0 64 64" fill="none" stroke="#00f0ff" stroke-width="2.2">',
      '          <rect x="10" y="28" width="16" height="22" rx="4" fill="rgba(0,240,255,0.15)"/>',
      '          <line x1="12" y1="28" x2="12" y2="12"/><line x1="16" y1="28" x2="16" y2="10"/>',
      '          <line x1="20" y1="28" x2="20" y2="12"/><line x1="24" y1="28" x2="24" y2="15"/>',
      '          <line x1="26" y1="36" x2="31" y2="28" stroke="#00ff9d" stroke-width="2.6"/>',
      '          <rect x="38" y="28" width="16" height="22" rx="4" fill="rgba(0,240,255,0.15)"/>',
      '          <line x1="40" y1="28" x2="40" y2="15"/><line x1="44" y1="28" x2="44" y2="12"/>',
      '          <line x1="48" y1="28" x2="48" y2="10"/><line x1="52" y1="28" x2="52" y2="12"/>',
      '          <line x1="38" y1="36" x2="33" y2="28" stroke="#00ff9d" stroke-width="2.6"/>',
      '        </svg>',
      '        <h3>1. Start / Accelerate</h3>',
      '        <p>Show <strong>both open hands</strong> in front of the webcam to engage thrusters and accelerate.</p>',
      '      </div>',
      '      <div class="hex-gesture-card">',
      '        <svg class="hex-gesture-svg" viewBox="0 0 64 64" fill="none" stroke="#00f0ff" stroke-width="2.2">',
      '          <rect x="20" y="26" width="22" height="26" rx="5" fill="rgba(0,240,255,0.15)"/>',
      '          <line x1="23" y1="26" x2="23" y2="10"/><line x1="29" y1="26" x2="29" y2="8"/>',
      '          <line x1="35" y1="26" x2="35" y2="10"/><line x1="40" y1="26" x2="40" y2="14"/>',
      '          <path d="M42 36 L27 38" stroke="#ffb800" stroke-width="3.2" stroke-linecap="round"/>',
      '          <path d="M18 56 L10 56 L14 52 M10 56 L14 60" stroke="#00ff9d" stroke-width="2.2"/>',
      '        </svg>',
      '        <h3>2. Steer Left</h3>',
      '        <p>Fold your <strong>Left Thumb</strong> inward across your palm. Extend it again to return straight.</p>',
      '      </div>',
      '      <div class="hex-gesture-card">',
      '        <svg class="hex-gesture-svg" viewBox="0 0 64 64" fill="none" stroke="#00f0ff" stroke-width="2.2">',
      '          <rect x="22" y="26" width="22" height="26" rx="5" fill="rgba(0,240,255,0.15)"/>',
      '          <line x1="24" y1="26" x2="24" y2="14"/><line x1="29" y1="26" x2="29" y2="10"/>',
      '          <line x1="35" y1="26" x2="35" y2="8"/><line x1="41" y1="26" x2="41" y2="10"/>',
      '          <path d="M22 36 L37 38" stroke="#ffb800" stroke-width="3.2" stroke-linecap="round"/>',
      '          <path d="M46 56 L54 56 L50 52 M54 56 L50 60" stroke="#00ff9d" stroke-width="2.2"/>',
      '        </svg>',
      '        <h3>3. Steer Right</h3>',
      '        <p>Fold your <strong>Right Thumb</strong> inward across your palm. Extend it again to return straight.</p>',
      '      </div>',
      '      <div class="hex-gesture-card">',
      '        <svg class="hex-gesture-svg" viewBox="0 0 64 64" fill="none" stroke="#00f0ff" stroke-width="2.2">',
      '          <rect x="22" y="26" width="20" height="26" rx="4" fill="rgba(0,240,255,0.15)"/>',
      '          <line x1="25" y1="26" x2="25" y2="10"/><line x1="30" y1="26" x2="30" y2="8"/>',
      '          <line x1="35" y1="26" x2="35" y2="10"/><line x1="40" y1="26" x2="40" y2="14"/>',
      '          <line x1="22" y1="36" x2="12" y2="26" stroke="#00ff9d" stroke-width="3"/>',
      '          <line x1="42" y1="36" x2="52" y2="26" stroke="#00ff9d" stroke-width="3"/>',
      '        </svg>',
      '        <h3>4. Drive Straight</h3>',
      '        <p>Keep <strong>both thumbs extended</strong> outward while holding both open hands up.</p>',
      '      </div>',
      '      <div class="hex-gesture-card">',
      '        <svg class="hex-gesture-svg" viewBox="0 0 64 64" fill="none" stroke="#ff3366" stroke-width="2.2">',
      '          <circle cx="32" cy="32" r="20" fill="rgba(255,51,102,0.12)"/>',
      '          <line x1="22" y1="22" x2="42" y2="42"/><line x1="42" y1="22" x2="22" y2="42"/>',
      '        </svg>',
      '        <h3>5. Stop / Coast</h3>',
      '        <p>Lower or <strong>remove your hands</strong> (or close your fingers) to cut thruster acceleration.</p>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="hex-modal-footer">',
      '    <button id="hex-modal-cancel" class="hex-modal-btn hex-modal-btn-secondary">Stay on Keyboard</button>',
      '    <button id="hex-modal-start" class="hex-modal-btn hex-modal-btn-primary">Activate Webcam Mode</button>',
      '  </div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(modal);

    /* ── Cache DOM references ────────────────────────────────────────── */
    this.dom = {
      hud: hud,
      modal: modal,
      dot: document.getElementById('hex-cam-dot'),
      btnGuide: document.getElementById('hex-btn-guide'),
      btnMinimize: document.getElementById('hex-btn-minimize'),
      btnModeKb: document.getElementById('hex-mode-kb'),
      btnModeCam: document.getElementById('hex-mode-cam'),
      video: document.getElementById('hex-webcam-video'),
      canvas: document.getElementById('hex-webcam-canvas'),
      ctx: document.getElementById('hex-webcam-canvas').getContext('2d'),
      placeholder: document.getElementById('hex-cam-placeholder'),
      placeholderText: document.getElementById('hex-cam-placeholder-text'),
      btnEnableCam: document.getElementById('hex-btn-enable-cam'),
      btnDisableCam: document.getElementById('hex-btn-disable-cam'),
      statusPerm: document.getElementById('hex-status-perm'),
      statusHands: document.getElementById('hex-status-hands'),
      indLeft: document.getElementById('hex-ind-left'),
      indLeftState: document.getElementById('hex-ind-left-state'),
      indRight: document.getElementById('hex-ind-right'),
      indRightState: document.getElementById('hex-ind-right-state'),
      statusGesture: document.getElementById('hex-status-gesture'),
      dirLeft: document.getElementById('hex-dir-left'),
      dirCenter: document.getElementById('hex-dir-center'),
      dirRight: document.getElementById('hex-dir-right'),
      steerFill: document.getElementById('hex-steer-fill'),
      btnAutoThrust: document.getElementById('hex-btn-autothrust'),
      modalCloseX: document.getElementById('hex-modal-close-x'),
      modalCancel: document.getElementById('hex-modal-cancel'),
      modalStart: document.getElementById('hex-modal-start')
    };

    /* ── Event bindings ──────────────────────────────────────────────── */
    var self = this;

    this.dom.btnMinimize.addEventListener('click', function() {
      self.dom.hud.classList.toggle('minimized');
    });

    if (this.dom.btnAutoThrust) {
      this.dom.btnAutoThrust.addEventListener('click', function() {
        self.autoThrust = !self.autoThrust;
        self.dom.btnAutoThrust.textContent = self.autoThrust ? 'Auto-Cruise: ON' : 'Auto-Cruise: OFF';
        self.dom.btnAutoThrust.style.color = self.autoThrust ? '#00f0ff' : '#888';
        self.dom.btnAutoThrust.style.borderColor = self.autoThrust ? '#00f0ff' : '#555';
      });
    }

    this.dom.btnGuide.addEventListener('click', function() {
      self.showInstructionsModal();
    });

    this.dom.btnModeKb.addEventListener('click', function() {
      self.setMode('keyboard');
    });

    this.dom.btnModeCam.addEventListener('click', function() {
      if (!self.hasShownInstructions) {
        self.showInstructionsModal();
      } else {
        self.setMode('webcam');
      }
    });

    this.dom.btnEnableCam.addEventListener('click', function() {
      if (!self.hasShownInstructions && self.mode !== 'webcam') {
        self.showInstructionsModal();
      } else {
        self.setMode('webcam');
      }
    });

    this.dom.btnDisableCam.addEventListener('click', function() {
      self.stopCamera();
      self.setMode('keyboard');
    });

    this.dom.modalCloseX.addEventListener('click', function() {
      self.hideInstructionsModal();
    });

    this.dom.modalCancel.addEventListener('click', function() {
      self.hideInstructionsModal();
      self.setMode('keyboard');
    });

    this.dom.modalStart.addEventListener('click', function() {
      self.hasShownInstructions = true;
      self.hideInstructionsModal();
      self.setMode('webcam');
    });
  };

  WebcamGestureController.prototype.showInstructionsModal = function() {
    if (this.dom && this.dom.modal) {
      this.dom.modal.classList.remove('hidden');
    }
  };

  WebcamGestureController.prototype.hideInstructionsModal = function() {
    if (this.dom && this.dom.modal) {
      this.dom.modal.classList.add('hidden');
    }
  };

  /* ─── Mode switching ────────────────────────────────────────────────── */

  /**
   * Switches between 'keyboard' and 'webcam' control modes.
   * @param {string} newMode    'keyboard' | 'webcam'
   * @param {boolean} skipMenuSync  true when called internally to avoid
   *                                re-triggering the onModeChange callback
   */
  WebcamGestureController.prototype.setMode = function(newMode, skipMenuSync) {
    if (newMode !== 'keyboard' && newMode !== 'webcam') return;
    this.mode = newMode;

    if (newMode === 'keyboard') {
      this.dom.btnModeKb.classList.add('active');
      this.dom.btnModeCam.classList.remove('active');
      this.resetGestureStates();
      this.dom.statusGesture.textContent = 'KEYBOARD ACTIVE';
      this.updateSteeringUI();
    } else {
      this.dom.btnModeKb.classList.remove('active');
      this.dom.btnModeCam.classList.add('active');
      if (!this.isCameraRunning) {
        this.startCamera();
      }
    }

    if (this.onModeChange && !skipMenuSync) {
      this.onModeChange(newMode);
    }
  };

  /* ─── MediaPipe initialisation ──────────────────────────────────────── */

  /**
   * Creates and configures the MediaPipe Hands instance (once).
   * Uses selfieMode: true so the library's own "Left"/"Right" labels
   * already correspond to the player's physical left and right hands
   * on a mirrored laptop webcam.
   */
  WebcamGestureController.prototype.initMediaPipe = function() {
    var self = this;
    if (this.hands) return Promise.resolve(this.hands);

    return new Promise(function(resolve, reject) {
      if (typeof window.Hands === 'undefined') {
        self.mediapipeFailed = true;
        reject(new Error('MediaPipe Hands library failed to load. Check internet connection.'));
        return;
      }

      try {
        var hands = new window.Hands({
          locateFile: function(file) {
            return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/' + file;
          }
        });

        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 0,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
          selfieMode: true  // mirrors X so 'Left' == player's left hand
        });

        hands.onResults(function(results) {
          self.onMediaPipeResults(results);
        });

        self.hands = hands;
        self.mediapipeLoaded = true;
        resolve(hands);
      } catch (err) {
        self.mediapipeFailed = true;
        reject(err);
      }
    });
  };

  /* ─── Camera lifecycle ──────────────────────────────────────────────── */

  /**
   * Requests webcam access and begins non-blocking async frame processing.
   * Falls back gracefully to keyboard mode on any failure.
   */
  WebcamGestureController.prototype.startCamera = function() {
    var self = this;
    if (this.isCameraRunning) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.setPermissionStatus('Unsupported Browser', 'err');
      this.showPlaceholder('WEBCAM API UNAVAILABLE<br><small>Fallback to Keyboard Mode active</small>');
      this.setMode('keyboard');
      return;
    }

    this.setPermissionStatus('Requesting...', 'warn');
    this.showPlaceholder('INITIALIZING NEURAL OPTICS...<br><small>Please allow browser camera access</small>');

    var requestCameraStream = function() {
      return navigator.mediaDevices.getUserMedia({
        video: {
          width:  { ideal: 640, min: 320 },
          height: { ideal: 480, min: 240 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: 'user'
        },
        audio: false
      }).catch(function() {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      });
    };

    this.initMediaPipe()
      .then(function() {
        return requestCameraStream();
      })
      .then(function(stream) {
        self.stream = stream;
        self.dom.video.srcObject = stream;

        // Detect unexpected camera disconnection
        var videoTracks = stream.getVideoTracks();
        if (videoTracks.length > 0) {
          videoTracks[0].addEventListener('ended', function() {
            self.handleCameraDisconnect();
          });
        }

        return self.dom.video.play();
      })
      .then(function() {
        self.isCameraRunning = true;
        self.dom.dot.classList.add('active');
        self.dom.placeholder.classList.add('hidden');
        self.dom.btnEnableCam.disabled = true;
        self.dom.btnDisableCam.disabled = false;
        self.setPermissionStatus('Granted (Live)', 'ok');
        self.startFrameLoop();
      })
      .catch(function(err) {
        console.warn('[HexGL WebcamGestureController]', err);
        var msg = 'Camera Error';
        var detail = 'Switching to Keyboard Mode';

        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          msg = 'Permission Denied';
          detail = 'Camera access was blocked. Allow camera permission in browser settings.';
        } else if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
          msg = 'No Camera Found';
          detail = 'No webcam device detected on this system.';
        } else if (self.mediapipeFailed) {
          msg = 'MediaPipe Offline';
          detail = 'Could not load MediaPipe Hands. Keyboard controls remain active.';
        }

        self.setPermissionStatus(msg, 'err');
        self.showPlaceholder(msg.toUpperCase() + '<br><small>' + detail + '</small>');
        self.stopCamera(true);
        self.setMode('keyboard');
      });
  };

  /**
   * Runs webcam landmark detection at ~30 FPS using setInterval with an
   * isProcessingFrame guard so the 60 FPS Three.js requestAnimationFrame
   * render loop is never blocked.
   */
  WebcamGestureController.prototype.startFrameLoop = function() {
    var self = this;
    if (this.frameTimer) clearInterval(this.frameTimer);

    this.frameTimer = setInterval(function() {
      if (!self.isCameraRunning || !self.hands || self.isProcessingFrame) return;
      if (self.dom.video.readyState < 2) return;

      self.isProcessingFrame = true;
      self.hands.send({ image: self.dom.video })
        .then(function() {
          self.isProcessingFrame = false;
        })
        .catch(function() {
          self.isProcessingFrame = false;
        });
    }, 33); // ~30 FPS cap
  };

  /**
   * Stops the webcam stream and cleans up all resources.
   * @param {boolean} keepPlaceholderMessage  If true, does not overwrite the
   *                  placeholder text (useful when showing an error before stopping).
   */
  WebcamGestureController.prototype.stopCamera = function(keepPlaceholderMessage) {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(function(track) { track.stop(); });
      this.stream = null;
    }

    if (this.dom && this.dom.video) {
      this.dom.video.srcObject = null;
    }

    this.isCameraRunning = false;
    this.isProcessingFrame = false;
    this.resetGestureStates();

    if (this.dom) {
      this.dom.dot.classList.remove('active');
      this.dom.btnEnableCam.disabled = false;
      this.dom.btnDisableCam.disabled = true;
      this.dom.ctx.clearRect(0, 0, this.dom.canvas.width, this.dom.canvas.height);
      if (!keepPlaceholderMessage) {
        this.setPermissionStatus('Disabled', 'warn');
        this.showPlaceholder('CAMERA OFFLINE<br><small>Click Enable Camera to resume</small>');
      }
    }
  };

  WebcamGestureController.prototype.handleCameraDisconnect = function() {
    this.stopCamera(true);
    this.setPermissionStatus('Disconnected', 'err');
    this.showPlaceholder('CAMERA DISCONNECTED<br><small>Reverted safely to Keyboard Mode</small>');
    this.setMode('keyboard');
  };

  /* ─── Landmark smoothing ────────────────────────────────────────────── */

  /**
   * Applies an Exponential Moving Average to raw MediaPipe landmarks
   * for the given hand label ('Left' | 'Right') to suppress jitter.
   */
  WebcamGestureController.prototype.smoothHandLandmarks = function(label, rawLandmarks) {
    var prev = this.smoothedLandmarks[label];
    if (!prev || prev.length !== rawLandmarks.length) {
      this.smoothedLandmarks[label] = rawLandmarks.map(function(pt) {
        return { x: pt.x, y: pt.y, z: pt.z || 0 };
      });
      return this.smoothedLandmarks[label];
    }

    var alpha = this.landmarkAlpha;
    for (var i = 0; i < rawLandmarks.length; i++) {
      prev[i].x = alpha * rawLandmarks[i].x + (1 - alpha) * prev[i].x;
      prev[i].y = alpha * rawLandmarks[i].y + (1 - alpha) * prev[i].y;
      prev[i].z = alpha * (rawLandmarks[i].z || 0) + (1 - alpha) * prev[i].z;
    }
    return prev;
  };

  /* ─── Per-hand gesture analysis ─────────────────────────────────────── */

  /**
   * Analyses a single smoothed hand to determine:
   *   - isOpenHand:    ≥3 of the 4 main fingers are extended
   *   - isThumbFolded: thumb tip is tucked inward across the palm
   *
   * Uses scale-invariant distances (normalised by palm width) plus an
   * inter-phalangeal bend angle with hysteresis to prevent jitter at the
   * fold/extend boundary.
   *
   * @param {Array}   lm              21 smoothed landmark objects {x,y,z}
   * @param {boolean} wasThumbFolded  Previous frame's fold state (hysteresis)
   */
  WebcamGestureController.prototype.analyzeSingleHand = function(lm, wasThumbFolded) {
    var wrist = lm[0];
    var palmWidth = Math.max(0.04, dist2D(lm[5], lm[17]));

    // Check if fingers (Index/Middle/Ring/Pinky) are extended
    var extendedCount = 0;
    var fingerPairs = [
      [8,  6, 5],  // Index tip, pip, mcp
      [12, 10, 9], // Middle tip, pip, mcp
      [16, 14, 13],// Ring tip, pip, mcp
      [20, 18, 17] // Pinky tip, pip, mcp
    ];

    for (var i = 0; i < fingerPairs.length; i++) {
      var tip = lm[fingerPairs[i][0]];
      var pip = lm[fingerPairs[i][1]];
      var mcp = lm[fingerPairs[i][2]];
      if (dist2D(tip, wrist) > dist2D(pip, wrist) * 0.95 && dist2D(tip, mcp) > palmWidth * 0.45) {
        extendedCount++;
      }
    }
    var isOpenHand = (extendedCount >= 2);
    var isFist = (extendedCount <= 1);

    // Scale-invariant thumb fold detection with hysteresis
    var thumbTip  = lm[4];
    var thumbIp   = lm[3];
    var thumbMcp  = lm[2];
    var indexMcp  = lm[5];
    var pinkyMcp  = lm[17];

    var normPinkyDist = dist2D(thumbTip, pinkyMcp) / palmWidth;
    var normIndexDist = dist2D(thumbTip, indexMcp) / palmWidth;
    var thumbBendAngle = angleBetween(thumbMcp, thumbIp, thumbTip);

    var isThumbFolded;
    if (wasThumbFolded) {
      isThumbFolded = (normPinkyDist < 1.35) || (normIndexDist < 0.75) || (thumbBendAngle < 145);
    } else {
      isThumbFolded = (normPinkyDist < 1.20) || (normIndexDist < 0.62) || (thumbBendAngle < 132);
    }

    var tiltX = lm[9].x - wrist.x;

    return {
      isOpenHand: isOpenHand,
      isFist: isFist,
      isThumbFolded: isThumbFolded,
      extendedCount: extendedCount,
      tiltX: tiltX
    };
  };

  /* ─── MediaPipe results callback ────────────────────────────────────── */

  /**
   * Called by MediaPipe Hands after each processed frame.
   * Resolves Left/Right handedness (accounting for selfieMode mirroring),
   * runs gesture analysis, applies stable-frame debouncing and cooldown,
   * then updates this.state and refreshes the HUD.
   */
  WebcamGestureController.prototype.onMediaPipeResults = function(results) {
    var ctx    = this.dom.ctx;
    var width  = this.dom.canvas.width;
    var height = this.dom.canvas.height;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    var landmarksList  = results.multiHandLandmarks || [];
    var handednessList = results.multiHandedness    || [];

    var leftHandLm  = null;
    var rightHandLm = null;

    // Resolve Left & Right hands; the spatial X fallback guards against
    // the rare case where MediaPipe swaps labels when hands cross.
    for (var i = 0; i < landmarksList.length; i++) {
      var rawLm    = landmarksList[i];
      var handInfo = handednessList[i];
      var label    = (handInfo && handInfo.label) ? handInfo.label : null;

      // Two-hand spatial sanity check
      if (landmarksList.length === 2 && i === 1) {
        var firstWristX  = landmarksList[0][0].x;
        var secondWristX = rawLm[0].x;
        // In selfieMode:true — smaller X is on the LEFT side of the mirrored preview
        if (leftHandLm  && label === 'Left')  label = 'Right';
        if (rightHandLm && label === 'Right') label = 'Left';
        if (Math.abs(firstWristX - secondWristX) > 0.08) {
          if (secondWristX < firstWristX) {
            leftHandLm  = this.smoothHandLandmarks('Left',  rawLm);
            rightHandLm = this.smoothHandLandmarks('Right', landmarksList[0]);
            continue;
          } else {
            rightHandLm = this.smoothHandLandmarks('Right', rawLm);
            leftHandLm  = this.smoothHandLandmarks('Left',  landmarksList[0]);
            continue;
          }
        }
      }

      if (label === 'Left') {
        leftHandLm  = this.smoothHandLandmarks('Left',  rawLm);
      } else {
        rightHandLm = this.smoothHandLandmarks('Right', rawLm);
      }
    }

    // Clear smoothed caches for hands no longer visible
    if (!leftHandLm)  this.smoothedLandmarks.Left  = null;
    if (!rightHandLm) this.smoothedLandmarks.Right = null;

    // Draw skeleton overlays on the preview canvas
    this.drawHandOverlay(ctx, leftHandLm,  '#00f0ff'); // neon blue  = left
    this.drawHandOverlay(ctx, rightHandLm, '#00ff9d'); // neon green = right
    ctx.restore();

    // Per-hand analysis
    var leftAnalysis = leftHandLm
      ? this.analyzeSingleHand(leftHandLm,  this.state.leftThumbFolded)
      : null;

    var rightAnalysis = rightHandLm
      ? this.analyzeSingleHand(rightHandLm, this.state.rightThumbFolded)
      : null;

    this.state.leftHandDetected  = !!leftHandLm;
    this.state.rightHandDetected = !!rightHandLm;
    this.state.bothHandsDetected = !!(leftHandLm && rightHandLm);
    this.state.leftHandOpen      = leftAnalysis ? leftAnalysis.isOpenHand : false;
    this.state.rightHandOpen     = rightAnalysis ? rightAnalysis.isOpenHand : false;
    this.state.leftThumbFolded   = leftAnalysis ? leftAnalysis.isThumbFolded : false;
    this.state.rightThumbFolded  = rightAnalysis ? rightAnalysis.isThumbFolded : false;

    // 1. Acceleration Intent
    var rawAccelerate = false;
    var rawBrake = false;

    if (this.autoThrust) {
      // Auto-cruise keeps ship flying forward; a closed fist activates brakes
      rawAccelerate = true;
      if ((leftAnalysis && leftAnalysis.isFist) || (rightAnalysis && rightAnalysis.isFist)) {
        rawAccelerate = false;
        rawBrake = true;
      }
    } else {
      // Manual thrust: ANY open hand accelerates!
      if (this.state.bothHandsDetected) {
        rawAccelerate = this.state.leftHandOpen || this.state.rightHandOpen;
      } else if (leftAnalysis) {
        rawAccelerate = leftAnalysis.isOpenHand;
        rawBrake = leftAnalysis.isFist;
      } else if (rightAnalysis) {
        rawAccelerate = rightAnalysis.isOpenHand;
        rawBrake = rightAnalysis.isFist;
      }
    }

    // 2. Steering Intent
    var rawSteer = 'STRAIGHT';
    var analogSteer = 0;

    if (this.state.bothHandsDetected) {
      // Two-hands steering wheel: left wrist vs right wrist Y difference
      // In selfieMode: leftHandLm is player's left hand, rightHandLm is player's right hand.
      var yDiff = rightHandLm[0].y - leftHandLm[0].y;
      if (Math.abs(yDiff) > 0.05) {
        analogSteer = Math.max(-1, Math.min(1, yDiff / 0.20));
        rawSteer = (analogSteer < 0) ? 'LEFT' : 'RIGHT';
      } else if (this.state.leftThumbFolded && !this.state.rightThumbFolded) {
        rawSteer = 'LEFT';
        analogSteer = -1;
      } else if (this.state.rightThumbFolded && !this.state.leftThumbFolded) {
        rawSteer = 'RIGHT';
        analogSteer = 1;
      }
    } else if (leftHandLm || rightHandLm) {
      // Single hand mode: position across camera OR hand tilt OR thumb fold
      var activeLm = leftHandLm || rightHandLm;
      var activeAnalysis = leftAnalysis || rightAnalysis;
      var wristX = activeLm[0].x;

      if (wristX < 0.40 || (activeAnalysis && activeAnalysis.tiltX < -0.06)) {
        rawSteer = 'LEFT';
        analogSteer = -Math.min(1, Math.max(0.4, (0.45 - wristX) / 0.25));
      } else if (wristX > 0.60 || (activeAnalysis && activeAnalysis.tiltX > 0.06)) {
        rawSteer = 'RIGHT';
        analogSteer = Math.min(1, Math.max(0.4, (wristX - 0.55) / 0.25));
      } else if (activeAnalysis && activeAnalysis.isThumbFolded) {
        rawSteer = leftHandLm ? 'LEFT' : 'RIGHT';
        analogSteer = leftHandLm ? -1 : 1;
      }
    }

    var now = performance.now();

    // Debounce acceleration
    if (rawAccelerate === this.candidateAccel) {
      this.candidateAccelFrames++;
    } else {
      this.candidateAccel       = rawAccelerate;
      this.candidateAccelFrames = 1;
    }
    if (
      this.candidateAccelFrames >= this.STABLE_FRAMES_REQUIRED &&
      this.committedAccel !== this.candidateAccel &&
      now - this.lastAccelChangeTime >= this.STATE_COOLDOWN_MS
    ) {
      this.committedAccel       = this.candidateAccel;
      this.lastAccelChangeTime  = now;
    }

    // Debounce steering
    if (rawSteer === this.candidateSteer) {
      this.candidateSteerFrames++;
    } else {
      this.candidateSteer       = rawSteer;
      this.candidateSteerFrames = 1;
    }
    if (
      this.candidateSteerFrames >= this.STABLE_FRAMES_REQUIRED &&
      this.committedSteer !== this.candidateSteer &&
      now - this.lastSteerChangeTime >= this.STATE_COOLDOWN_MS
    ) {
      this.committedSteer      = this.candidateSteer;
      this.lastSteerChangeTime = now;
    }

    this.state.accelerate    = this.committedAccel;
    this.state.brake         = rawBrake;
    this.state.steerLeft     = (this.committedSteer === 'LEFT');
    this.state.steerRight    = (this.committedSteer === 'RIGHT');
    this.state.analogSteer   = analogSteer;
    this.state.steeringLabel = this.committedSteer;

    // Compose descriptive gesture label for HUD
    if (rawBrake) {
      this.state.gestureName = 'FIST DETECTED (BRAKING)';
    } else if (this.state.accelerate) {
      if (this.state.bothHandsDetected) {
        if (Math.abs(analogSteer) > 0.15) {
          this.state.gestureName = (analogSteer < 0 ? 'WHEEL TURN LEFT' : 'WHEEL TURN RIGHT');
        } else if (this.state.steerLeft) {
          this.state.gestureName = 'LEFT THUMB (STEER LEFT)';
        } else if (this.state.steerRight) {
          this.state.gestureName = 'RIGHT THUMB (STEER RIGHT)';
        } else {
          this.state.gestureName = this.autoThrust ? 'AUTO-CRUISE FORWARD' : 'BOTH HANDS (THRUST)';
        }
      } else if (this.state.leftHandDetected || this.state.rightHandDetected) {
        if (this.state.steerLeft)  this.state.gestureName = 'HAND TILT (STEER LEFT)';
        else if (this.state.steerRight) this.state.gestureName = 'HAND TILT (STEER RIGHT)';
        else this.state.gestureName = this.autoThrust ? 'AUTO-CRUISE FORWARD' : 'OPEN HAND (THRUST)';
      } else {
        this.state.gestureName = this.autoThrust ? 'AUTO-CRUISE (READY)' : 'NO HANDS (STOPPED)';
      }
    } else {
      this.state.gestureName = 'COASTING / STOPPED';
    }

    this.updateTelemetryUI();
  };

  /* ─── Canvas overlay rendering ──────────────────────────────────────── */

  /**
   * Draws the hand skeleton and landmark dots on the preview canvas.
   * X coordinates are inverted to align with the CSS scaleX(-1) mirror applied
   * to both the video element and this canvas.
   */
  WebcamGestureController.prototype.drawHandOverlay = function(ctx, lm, color) {
    if (!lm) return;
    var w = this.dom.canvas.width;
    var h = this.dom.canvas.height;

    var connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17]
    ];

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    for (var i = 0; i < connections.length; i++) {
      var a = lm[connections[i][0]];
      var b = lm[connections[i][1]];
      ctx.beginPath();
      // Invert X so landmarks align with the CSS-mirrored video feed
      ctx.moveTo((1 - a.x) * w, a.y * h);
      ctx.lineTo((1 - b.x) * w, b.y * h);
      ctx.stroke();
    }

    for (var j = 0; j < lm.length; j++) {
      var pt = lm[j];
      ctx.fillStyle = (j === 4) ? '#ffb800' : '#ffffff'; // thumb tip = amber
      ctx.beginPath();
      ctx.arc((1 - pt.x) * w, pt.y * h, j === 4 ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* ─── ShipControls interface ────────────────────────────────────────── */

  /**
   * Called every frame by ShipControls.prototype.update(dt).
   * Advances the smoothed steerValue analogue and returns the current
   * control inputs. This is the sole bridge between the gesture system
   * and the physics engine.
   *
   * @param  {number} dt  Delta-time from the Three.js render loop
   * @return {{ forward: boolean, left: boolean, right: boolean, steerValue: number }}
   */
  WebcamGestureController.prototype.getControlInputs = function(dt) {
    var targetSteer = 0;
    if (this.state.steerLeft) targetSteer = -1;
    else if (this.state.steerRight) targetSteer = 1;

    if (this.state.analogSteer !== undefined && Math.abs(this.state.analogSteer) > 0.05) {
      targetSteer = this.state.analogSteer;
    }

    var dtSeconds = (dt && dt > 0.2) ? (dt * 0.0166) : (dt || 0.0166);
    var blend = Math.min(1, (this.steerSmoothing || 12.0) * dtSeconds);
    this.state.steerValue += (targetSteer - this.state.steerValue) * blend;

    // Snap to zero to prevent infinite micro-oscillation
    if (Math.abs(this.state.steerValue) < 0.01 && targetSteer === 0) {
      this.state.steerValue = 0;
    }

    this.updateSteeringUI();

    return {
      forward:    this.state.accelerate,
      backward:   this.state.brake || false,
      left:       this.state.steerLeft || (this.state.steerValue < -0.15),
      right:      this.state.steerRight || (this.state.steerValue > 0.15),
      steerValue: this.state.steerValue
    };
  };

  /* ─── State management ──────────────────────────────────────────────── */

  WebcamGestureController.prototype.resetGestureStates = function() {
    this.state.leftHandDetected  = false;
    this.state.rightHandDetected = false;
    this.state.bothHandsDetected = false;
    this.state.leftThumbFolded   = false;
    this.state.rightThumbFolded  = false;
    this.state.accelerate        = this.autoThrust;
    this.state.brake             = false;
    this.state.steerLeft         = false;
    this.state.steerRight        = false;
    this.state.analogSteer       = 0;
    this.state.steerValue        = 0;
    this.state.gestureName       = this.autoThrust ? 'AUTO-CRUISE READY' : 'IDLE';
    this.state.steeringLabel     = 'STRAIGHT';
    this.candidateAccel          = this.autoThrust;
    this.candidateSteer          = 'STRAIGHT';
    this.committedAccel          = this.autoThrust;
    this.committedSteer          = 'STRAIGHT';
    this.updateTelemetryUI();
  };

  /* ─── UI update helpers ─────────────────────────────────────────────── */

  WebcamGestureController.prototype.setPermissionStatus = function(text, level) {
    this.permissionStatus = text;
    if (!this.dom) return;
    this.dom.statusPerm.textContent  = text;
    this.dom.statusPerm.className    = 'hex-status-value ' + (level || '');
  };

  WebcamGestureController.prototype.showPlaceholder = function(html) {
    if (!this.dom) return;
    this.dom.placeholderText.innerHTML = html;
    this.dom.placeholder.classList.remove('hidden');
  };

  WebcamGestureController.prototype.updateTelemetryUI = function() {
    if (!this.dom) return;

    var count = (this.state.leftHandDetected ? 1 : 0) + (this.state.rightHandDetected ? 1 : 0);
    this.dom.statusHands.textContent = count === 2
      ? '2 Hands (Locked)' : (count === 1 ? '1 Hand' : 'No Hands');
    this.dom.statusHands.className   = 'hex-status-value ' +
      (count === 2 ? 'ok' : (count === 1 ? 'warn' : ''));

    // Left hand indicator
    this.dom.indLeft.className = 'hex-hand-pill' +
      (this.state.leftHandDetected ? ' detected' : '') +
      (this.state.leftThumbFolded  ? ' thumb-folded' : '');
    this.dom.indLeftState.textContent = !this.state.leftHandDetected
      ? 'OFF' : (this.state.leftThumbFolded ? 'THUMB FOLD' : 'OPEN');

    // Right hand indicator
    this.dom.indRight.className = 'hex-hand-pill' +
      (this.state.rightHandDetected ? ' detected' : '') +
      (this.state.rightThumbFolded  ? ' thumb-folded' : '');
    this.dom.indRightState.textContent = !this.state.rightHandDetected
      ? 'OFF' : (this.state.rightThumbFolded ? 'THUMB FOLD' : 'OPEN');

    if (this.mode === 'webcam') {
      this.dom.statusGesture.textContent = this.state.gestureName;
    }
  };

  WebcamGestureController.prototype.updateSteeringUI = function() {
    if (!this.dom) return;
    var val = this.state.steerValue;

    this.dom.dirLeft.className   = val < -0.15 ? 'active-dir' : '';
    this.dom.dirRight.className  = val >  0.15 ? 'active-dir' : '';
    this.dom.dirCenter.className = Math.abs(val) <= 0.15 ? 'active-dir' : '';

    var pct = Math.min(50, Math.abs(val) * 50);
    if (val < 0) {
      this.dom.steerFill.style.left  = (50 - pct) + '%';
      this.dom.steerFill.style.width = pct + '%';
    } else {
      this.dom.steerFill.style.left  = '50%';
      this.dom.steerFill.style.width = pct + '%';
    }
  };

  /* ─── Lifecycle ─────────────────────────────────────────────────────── */

  WebcamGestureController.prototype.bindLifecycleEvents = function() {
    var self = this;
    window.addEventListener('beforeunload', function() {
      self.stopCamera(true);
    });
  };

  /* ─── Singleton accessor ────────────────────────────────────────────── */

  /**
   * Returns (creating if necessary) the single shared controller instance.
   * Both ShipControls.js and launch.js call this to get the same object.
   */
  WebcamGestureController.getInstance = function(options) {
    if (!window.__hexglWebcamController) {
      window.__hexglWebcamController = new WebcamGestureController(options);
    } else if (options && options.onModeChange) {
      // Allow late registration of the onModeChange callback (e.g. from launch.js)
      window.__hexglWebcamController.onModeChange = options.onModeChange;
    }
    return window.__hexglWebcamController;
  };

  bkcore.controllers.WebcamGestureController = WebcamGestureController;

})();
