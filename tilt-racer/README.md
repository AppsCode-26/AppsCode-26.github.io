# Tilt Racer

A 3D driving game for the browser, made for the iPad. You steer by tilting the iPad: tilt it right and the car goes right.

It runs straight from GitHub Pages with no install and no build step. Everything is plain HTML and JavaScript using [three.js](https://threejs.org/), and the copy of three.js is included in the repo.

## Play

1. Open the game in **Safari on your iPad** (it must be served over HTTPS, which GitHub Pages does).
2. Hold the iPad in landscape like a steering wheel.
3. Turn on **Rotation Lock** in Control Center so tilting doesn't rotate the screen.
4. Tap **TAP TO START** and allow motion access when Safari asks.
5. Optional: Share → **Add to Home Screen** to play full screen.

### Controls

| Action | iPad | Keyboard |
| --- | --- | --- |
| Steer | Tilt the iPad left / right (or the ◀ ▶ buttons in *Touch* steering mode) | ← → / A D |
| Accelerate | GAS pedal (bottom right) | ↑ / W |
| Brake / reverse | BRAKE pedal (bottom left), hold it while stopped to reverse | ↓ / S |
| Handbrake (drift) | HANDBRAKE button | Space |
| Reset car | ↺ button | R |
| Change camera | 🎥 button (chase, far chase, hood, bumper) | C |
| Pause | ❚❚ button | Esc / P |

In **Settings** you can change tilt sensitivity, re-centre the tilt (*Calibrate centre*), flip the tilt direction, turn on auto-accelerate, switch driving assists (traction and stability control) on or off, choose km/h or mph, and pick a graphics level.

## Game modes

- **Free Drive**: a 1.6 km × 1.6 km open world surrounded by snowy mountains. It has a ring highway, a town crossroads with buildings, a lake, a forest dirt trail, an airfield with jump ramps, and a sand quarry full of kickers. You earn coins by driving and by collecting the gold coins on the roads. Blue bonus coins float above the big jumps.
- **Dirt Race**: race 5 AI drivers on three dirt tracks:
  - *Dust Bowl*: a fast desert circuit.
  - *Pine Ridge*: a forest stage with elevation changes and a crest jump.
  - *Canyon Run*: a long red-rock canyon with jumps and hairpins.

  Choose Easy, Medium or Hard AI and the number of laps. The game saves your best lap and the AI's best lap for each track so you can try to beat their times. Coins are paid out by finishing position and difficulty, with a bonus for a new lap record.
- **Garage**: switch between the three cars, change the paint colour, and spend coins on upgrades.

## Cars

| Car | Type | Character |
| --- | --- | --- |
| **Vortex GT** | Rear-wheel-drive sports car | Highest top speed (~300 km/h) and strong grip on tarmac, but slides around on dirt and grass |
| **Ironhorse 4x4** | Off-road truck | Heavy, high centre of gravity, slow to accelerate; big tyres and suspension mean grass, sand and bumps barely slow it |
| **Strada R4** | All-wheel-drive rally car | Light, short gearing and quick steering. Best on dirt, quick everywhere |

Each car has three upgrades with 5 levels each:

- **Engine**: more torque, taller gearing and a higher top speed.
- **Handling**: faster steering, stiffer suspension and a lower centre of gravity.
- **Tyres**: more grip on every surface and shorter braking distances.

The garage measures the 0–100 km/h time and top speed by actually running the physics simulation, so the numbers update as you upgrade.

## How it works

- `js/physics.js` is the vehicle dynamics. It uses a single-track model with a Pacejka-style tyre curve and a friction circle, weight transfer, an engine torque curve with an automatic gearbox, aerodynamic drag, rolling resistance per surface, slopes, and spring/damper suspension (cars really take off over crests and ramps). It also handles car-to-car and car-to-wall collision impulses.
- `js/input.js` turns `deviceorientation` events into a steering angle. It converts the gravity direction into screen coordinates using the current screen orientation, so "tilt right = steer right" holds in either landscape direction.
- `js/ai.js` contains the AI drivers. They follow a minimum-curvature racing line using pure-pursuit steering, brake for corners based on how much grip their car has, steer around other cars, and recover when stuck. They drive the same physics as you.
- `js/raceCore.js` and `js/freeRoamCore.js` hold the track and world data: terrain heightfields, surfaces, obstacles, laps and checkpoints.
- `js/raceWorld.js`, `js/freeRoamWorld.js`, `js/carModels.js` and `js/environment.js` build the 3D scenes. All models and textures are generated in code, so the game needs no image downloads.
- `js/audio.js` synthesises engine, tyre, gravel, wind and impact sounds with the Web Audio API.

## Run locally

```sh
cd tilt-racer
npx serve .            # or any static web server
```

Then open the printed URL. Tilt steering needs HTTPS on a real iPad; on a computer, use the keyboard.

## Tests

```sh
cd tilt-racer
npm test
```

The tests check the car physics (top speeds, braking, steering direction, reverse, upgrades). They also run headless AI races on every track to make sure every AI car finishes.
