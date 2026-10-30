$ = (_) -> document.getElementById _

init = (controlType, quality, hud, godmode) ->
  hexGL = new bkcore.hexgl.HexGL(
    document: document
    width: window.innerWidth
    height: window.innerHeight
    container: $ 'main'
    overlay: $ 'overlay'
    gameover: $ 'step-5'
    quality: quality
    difficulty: 0
    hud: hud is 1
    controlType: controlType
    godmode: godmode
    track: 'Cityscape'
  )
  window.hexGL=hexGL

  progressbar = $ 'progressbar'
  hexGL.load(
    onLoad: ->
      console.log 'LOADED.'
      hexGL.init()
      $('step-3').style.display = 'none'
      $('step-4').style.display = 'block'
      hexGL.start()
    onError: (s) ->
      console.error "Error loading #{ s }."
    onProgress: (p, t, n) ->
      console.log("LOADED "+t+" : "+n+" ( "+p.loaded+" / "+p.total+" ).")
      progressbar.style.width = "#{ p.loaded / p.total * 100 }%"
  )

u = bkcore.Utils.getURLParameter

defaultControls = if bkcore.Utils.isTouchDevice() then 1 else 0

s = [
  ['controlType', ['KEYBOARD', 'TOUCH', 'LEAP MOTION CONTROLLER',
    'GAMEPAD', 'WEBCAM GESTURE'], defaultControls, defaultControls, 'Controls: ']
  ['quality', ['LOW', 'MID', 'HIGH', 'VERY HIGH'], 3, 3, 'Quality: ']
  ['hud', ['OFF', 'ON'], 1, 1, 'HUD: ']
  ['godmode', ['OFF', 'ON'], 0, 1, 'Godmode: ']
]

for a in s
  do(a)->
    a[3] = u(a[0]) ? a[2]
    e = $ "s-#{a[0]}"
    (f = -> e.innerHTML = a[4]+a[1][a[3]])()
    e.onclick = -> f(a[3] = (a[3]+1)%a[1].length)

if bkcore.controllers?.WebcamGestureController
  webcamCtrl = bkcore.controllers.WebcamGestureController.getInstance
    onModeChange: (mode) ->
      s[0][3] = if mode is 'webcam' then 4 else 0
      el = $ "s-#{s[0][0]}"
      el?.innerHTML = s[0][4] + s[0][1][s[0][3]]

  origCtrlOnclick = $('s-controlType').onclick
  $('s-controlType').onclick = ->
    origCtrlOnclick?()
    setTimeout (->
      if s[0][3] is 4
        webcamCtrl.showInstructionsModal()
        webcamCtrl.setMode 'webcam', true
      else
        webcamCtrl.setMode 'keyboard', true
    ), 0

$('step-2').onclick = ->
  $('step-2').style.display = 'none'
  $('step-3').style.display = 'block'
  init s[0][3], s[1][3], s[2][3], s[3][3]
$('step-5').onclick = ->
  window.location.reload()
$('s-credits').onclick = ->
  $('step-1').style.display = 'none'
  $('credits').style.display = 'block'
$('credits').onclick = ->
  $('step-1').style.display = 'block'
  $('credits').style.display = 'none'

hasWebGL = ->
  canvas = document.createElement 'canvas'
  opts = { failIfMajorPerformanceCaveat: false }
  gl = null
  try gl = canvas.getContext('webgl', opts) or canvas.getContext('webgl')
  if not gl?
    try gl = canvas.getContext('experimental-webgl', opts) or canvas.getContext('experimental-webgl')
  if not gl?
    try gl = canvas.getContext('webgl2', opts) or canvas.getContext('webgl2')
  return gl?

startBtn = $('start')
proceedToStep2 = ->
  $('step-1').style.display = 'none'
  $('step-2').style.display = 'block'
  $('step-2').style.backgroundImage = "url(css/help-#{s[0][3]}.png)"

if not hasWebGL()
  if window.location.protocol is 'file:'
    startBtn.innerHTML = 'START (HTTP Recommended)'
    startBtn.title = 'WebGL is restricted on file:/// URLs. Run via http://localhost:8080/'
  else
    startBtn.innerHTML = 'LAUNCH (WebGL Warning)'
  startBtn.onclick = proceedToStep2
else
  startBtn.onclick = proceedToStep2

if window.location.protocol is 'file:'
  banner = document.createElement 'div'
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:rgba(230,80,0,0.92);color:#fff;font-family:sans-serif;font-size:13px;text-align:center;padding:7px 10px;font-weight:bold;box-shadow:0 2px 8px rgba(0,0,0,0.5);'
  banner.innerHTML = '⚠️ Note: Webcam & WebGL work best via HTTP. Server is running at: <a href="http://localhost:8080/" style="color:#00f0ff;margin:0 6px;">http://localhost:8080/</a> or <a href="http://localhost:8081/" style="color:#00f0ff;margin:0 6px;">http://localhost:8081/</a>'
  document.body.appendChild banner
