import * as THREE from 'three';

import { SunLight } from 'three/addons/lights/SunLight.js';
import { Sky } from 'three/addons/objects/Sky.js';

// world layout: a dome of radius ARENA_RADIUS centred on the origin, y is up, the bird starts facing -x

const BIRD_RADIUS = 1.5;

const BASE_SPEED = 28;
const SPEED_STEP = 0.25; // added to the speed factor at every speed up
const SPEED_INTERVAL = 8; // seconds between speed ups
const MAX_SPEED_FACTOR = 4;

const MOVE_RESPONSE = 5; // how quickly the bird reaches the requested velocity
const TURN_SPEED = 1.9; // radians per second

const ARENA_RADIUS = 400; // the bird can not leave this sphere
const MIN_HEIGHT = 1.5; // touching the ground at this height is fatal

const GRAVITY = - 45;
const LIFT = 105; // upward acceleration while space is held, gravity still applies
const JUMP = 18; // instant upward speed on the press itself, before the lift builds up
const MAX_RISE = 40, MAX_FALL = 55;

const BLOCK_COUNT = 1900;
const BLOCK_GAP = 9; // minimum free space between two blocks
const SPAWN_CLEARANCE = 25; // no blocks this close to the start position

const RING_RADIUS = 5;
const RING_CLEARANCE = 1.5; // free space kept between a ring and the blocks around it
const RING_TIME = 6; // seconds granted for every ring, on top of the travel time
const MAX_MISSES = 3;

const TOWER_COUNT = 70; // skyline outside the dome

const BLOOD_COUNT = 140;
const BLOOD_GRAVITY = - 60;

const SUN_AZIMUTH = 120;
const SUN_NOON = 40, SUN_DUSK = 5;

const _sunDay = new THREE.Color( 0xfff2e3 ), _sunDusk = new THREE.Color( 0xff8a3d );
const _fogDay = new THREE.Color( 0xd8e2ea ), _fogDusk = new THREE.Color( 0xd9a273 );
const _towerColors = [ new THREE.Color( 0x08d9d6 ), new THREE.Color( 0xff2e63 ) ];
const _blockColors = [ new THREE.Color( 0x1f8a36 ), new THREE.Color( 0xe07a1f ), new THREE.Color( 0x6a4cc2 ) ];

const scoreElement = document.getElementById( 'score' );
const bestElement = document.getElementById( 'best' );
const infoElement = document.getElementById( 'info' );
const messageElement = document.getElementById( 'message' );
const flashElement = document.getElementById( 'flash' );
const mobileControls = document.getElementById( 'mobile-controls' );
const liftButton = document.getElementById( 'lift-btn' );

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test( navigator.userAgent );

let renderer, scene, camera, timer, sunLight, sky, sceneEnv, pmremGenerator, renderTarget;
let blocks, ring, beacon, blood, bird, wings;

const dummy = new THREE.Object3D();
const keys = new Set();
const pointer = { down: false, x: 0, y: 0 };
const touch = { forward: 0, strafe: 0, turn: 0, lift: false };

const start = new THREE.Vector3( 0, 40, 0 ); // held in the air until the first input
const velocity = new THREE.Vector3();

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wanted = new THREE.Vector3();
const _target = new THREE.Vector3();

const blockList = []; // { x, y, z, hx, hy, hz } with h* being half sizes
const drops = [];

const game = {
	state: 'ready', // ready | playing | dead
	yaw: 0,
	score: 0,
	misses: 0,
	ringTime: 0,
	playTime: 0,
	speedLevel: 0,
	messageTime: 0,
	best: loadBest(),
	deadTime: 0,
	elevation: SUN_NOON,
	bakedElevation: Infinity,
	info: ''
};

init();

function loadBest() {

	try {

		return Number( localStorage.getItem( 'flappy-sun-best' ) ) || 0;

	} catch ( e ) {

		return 0;

	}

}

function saveBest() {

	try {

		localStorage.setItem( 'flappy-sun-best', String( game.best ) );

	} catch ( e ) {}

}

function speedFactor() {

	return Math.min( MAX_SPEED_FACTOR, 1 + game.speedLevel * SPEED_STEP );

}

// writes a random point inside the dome into target, margin keeps it away from the shell

function randomInDome( target, margin ) {

	do {

		target.set( Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1 );

	} while ( target.lengthSq() > 1 );

	return target.multiplyScalar( ARENA_RADIUS - margin );

}

// blocks: pillars, long boxes, small boxes and big cubes scattered through the whole dome, up to the top

function createBlocks() {

	const material = new THREE.MeshStandardMaterial( { roughness: 0.7 } );

	blocks = new THREE.InstancedMesh( new THREE.BoxGeometry( 1, 1, 1 ), material, BLOCK_COUNT );

	// the attempt limit only matters if the dome is too small to fit every block with its gap

	for ( let attempt = 0; attempt < BLOCK_COUNT * 200 && blockList.length < BLOCK_COUNT; attempt ++ ) {

		randomInDome( _target, 8 );

		const block = { x: _target.x, y: _target.y, z: _target.z, hx: 0, hy: 0, hz: 0 };

		block.hx = 2 + Math.random() * 3.5;
		block.hy = 2 + Math.random() * 3.5;
		block.hz = 2 + Math.random() * 3.5;

		const type = Math.random();

		if ( type < 0.2 ) {

			// pillar standing on the ground, the random point is its top

			block.hy = THREE.MathUtils.clamp( block.y / 2, 5, 30 );
			block.y = block.hy;

		} else if ( type < 0.55 ) {

			// long box floating in the air, stretched along a random axis

			const axis = [ 'hx', 'hy', 'hz' ][ Math.floor( Math.random() * 3 ) ];

			block[ axis ] = 10 + Math.random() * 18;

		} else if ( type > 0.88 ) {

			// big cube

			block.hx = block.hy = block.hz = 9 + Math.random() * 9;

		}

		block.y = Math.max( block.y, block.hy + ( type < 0.2 ? 0 : 3 ) );

		if ( distanceToBlock( start, block ) < SPAWN_CLEARANCE ) continue;
		if ( blockList.some( other => blockGap( block, other ) < BLOCK_GAP ) ) continue;

		dummy.position.set( block.x, block.y, block.z );
		dummy.scale.set( block.hx * 2, block.hy * 2, block.hz * 2 );
		dummy.updateMatrix();

		blocks.setMatrixAt( blockList.length, dummy.matrix );
		blocks.setColorAt( blockList.length, _blockColors[ blockList.length % _blockColors.length ] );

		blockList.push( block );

	}

	blocks.count = blockList.length;
	blocks.castShadow = true;
	blocks.receiveShadow = true;
	scene.add( blocks );

}

// free space between two blocks

function blockGap( a, b ) {

	const dx = Math.max( Math.abs( a.x - b.x ) - a.hx - b.hx, 0 );
	const dy = Math.max( Math.abs( a.y - b.y ) - a.hy - b.hy, 0 );
	const dz = Math.max( Math.abs( a.z - b.z ) - a.hz - b.hz, 0 );

	return Math.hypot( dx, dy, dz );

}

function distanceToBlock( point, block ) {

	const dx = Math.max( Math.abs( point.x - block.x ) - block.hx, 0 );
	const dy = Math.max( Math.abs( point.y - block.y ) - block.hy, 0 );
	const dz = Math.max( Math.abs( point.z - block.z ) - block.hz, 0 );

	return Math.hypot( dx, dy, dz );

}

function touchesBlock( point, radius ) {

	for ( const block of blockList ) {

		if ( distanceToBlock( point, block ) < radius ) return true;

	}

	return false;

}

// rings: one checkpoint at a time, somewhere in the dome and clear of the blocks

function placeRing() {

	do {

		randomInDome( ring.position, 15 );
		ring.position.y = Math.max( ring.position.y, 8 );

	} while ( touchesBlock( ring.position, RING_RADIUS + RING_CLEARANCE ) || ring.position.distanceTo( bird.position ) < 40 );

	// the beacon is a column of light that makes the ring easy to find from anywhere

	beacon.position.set( ring.position.x, ARENA_RADIUS / 2, ring.position.z );

	// enough time to fly there at the current speed, plus some slack

	game.ringTime = RING_TIME + ring.position.distanceTo( bird.position ) / ( BASE_SPEED * speedFactor() * 0.6 );

}

function checkRing( delta ) {

	game.ringTime -= delta;

	if ( bird.position.distanceTo( ring.position ) < RING_RADIUS ) {

		game.score ++;
		placeRing();
		updateHud();

	} else if ( game.ringTime <= 0 ) {

		game.misses ++;
		updateHud();

		if ( game.misses >= MAX_MISSES ) die( 'missed ' + MAX_MISSES + ' rings' );
		else {

			placeRing();
			setMessage( 'too slow, ring moved', 1.2 );

		}

	}

}

// skyline outside the dome

function createTowers() {

	const towers = new THREE.InstancedMesh( new THREE.BoxGeometry( 1, 1, 1 ), new THREE.MeshStandardMaterial(), TOWER_COUNT );

	for ( let i = 0; i < TOWER_COUNT; i ++ ) {

		const angle = Math.random() * Math.PI * 2;
		const distance = ARENA_RADIUS + 40 + Math.random() * 260;
		const height = 20 + Math.random() * 60;

		dummy.position.set( Math.cos( angle ) * distance, height / 2, Math.sin( angle ) * distance );
		dummy.scale.set( 14, height, 14 );
		dummy.updateMatrix();

		towers.setMatrixAt( i, dummy.matrix );
		towers.setColorAt( i, _towerColors[ i % 2 ] );

	}

	towers.castShadow = true;
	towers.receiveShadow = true;
	scene.add( towers );

}

// blood: drops burst out of the bird, fall, and stay on the ground as flat stains

function spawnBlood() {

	for ( const drop of drops ) {

		drop.position.copy( bird.position );
		drop.landed = false;
		drop.size = 0.25 + Math.random() * 0.55;

		// random direction, biased upwards and carried along by the momentum of the bird

		drop.velocity.randomDirection().multiplyScalar( 4 + Math.random() * 22 );
		drop.velocity.y = Math.abs( drop.velocity.y ) * 0.9 + 4;
		drop.velocity.addScaledVector( velocity, 0.2 + Math.random() * 0.5 );

	}

	blood.visible = true;

}

function updateBlood( delta ) {

	if ( blood.visible === false ) return;

	for ( let i = 0; i < drops.length; i ++ ) {

		const drop = drops[ i ];

		if ( drop.landed === false ) {

			drop.velocity.y += BLOOD_GRAVITY * delta;
			drop.position.addScaledVector( drop.velocity, delta );

			if ( drop.position.y <= 0.05 ) {

				drop.position.y = 0.05;
				drop.landed = true;

			}

		}

		const size = drop.size;

		dummy.position.copy( drop.position );

		if ( drop.landed ) dummy.scale.set( size * 3, 0.04, size * 3 );
		else dummy.scale.setScalar( size );

		dummy.updateMatrix();
		blood.setMatrixAt( i, dummy.matrix );

	}

	blood.instanceMatrix.needsUpdate = true;

}

// sun

function updateSun() {

	sunLight.position.setFromSphericalCoords( 1, THREE.MathUtils.degToRad( 90 - game.elevation ), THREE.MathUtils.degToRad( SUN_AZIMUTH ) );

	// the sun light warms up and fades towards the horizon

	const daylight = Math.min( 1, game.elevation / 30 );

	sunLight.color.lerpColors( _sunDusk, _sunDay, daylight );
	sunLight.intensity = 3 + daylight * 2;

	scene.fog.color.lerpColors( _fogDusk, _fogDay, daylight );

	sky.material.uniforms.sunPosition.value.copy( sunLight.position );

	// baking the sky into the environment is expensive, so only do it once per degree

	if ( Math.abs( game.elevation - game.bakedElevation ) < 1 ) return;
	game.bakedElevation = game.elevation;

	if ( renderTarget !== undefined ) renderTarget.dispose();

	sceneEnv.add( sky );
	renderTarget = pmremGenerator.fromScene( sceneEnv );
	scene.add( sky );

	scene.environment = renderTarget.texture;

}

// game flow

function setMessage( text, duration = Infinity ) {

	messageElement.textContent = text;
	game.messageTime = duration;

}

function updateHud() {

	scoreElement.textContent = game.score;
	bestElement.textContent = game.best > 0 ? 'best ' + game.best : '';

}

function updateInfo() {

	let info = 'speed x' + speedFactor().toFixed( 2 ) + ' · missed ' + game.misses + '/' + MAX_MISSES;

	if ( game.state === 'playing' ) {

		info += ' · ring ' + Math.round( bird.position.distanceTo( ring.position ) ) + ' m · ' + Math.max( 0, game.ringTime ).toFixed( 1 ) + ' s';

	}

	if ( info !== game.info ) infoElement.textContent = game.info = info;

}

function reset() {

	game.state = 'ready';
	game.yaw = 0;
	game.score = 0;
	game.misses = 0;
	game.playTime = 0;
	game.speedLevel = 0;
	game.elevation = SUN_NOON;

	velocity.set( 0, 0, 0 );

	bird.position.copy( start );
	bird.rotation.set( 0, 0, 0 );
	bird.visible = true;

	blood.visible = false;
	flashElement.classList.remove( 'dead' );

	placeRing();
	updateSun();
	updateHud();
	setMessage( isMobile
		? 'left stick move · right stick turn · hold rise to go up\nreach each ring in time, dodge the blocks and the floor'
		: 'W A S D move · arrows turn · hold space to rise, let go to fall\nreach each ring in time, dodge the blocks and the floor' );

}

function die( reason ) {

	game.state = 'dead';
	game.deadTime = 0;

	if ( game.score > game.best ) {

		game.best = game.score;
		saveBest();

	}

	spawnBlood();

	bird.visible = false;
	flashElement.classList.add( 'dead' );

	updateHud();
	setMessage( reason + ( isMobile ? '\ntap to retry' : '\nspace / click / tap to retry' ) );

}

function begin() {

	if ( game.state !== 'ready' ) return;

	game.state = 'playing';
	setMessage( '' );
	placeRing(); // restarts the ring timer

	velocity.y = JUMP; // a first hop, so the fall does not start right away

}

function retry() {

	if ( game.state === 'dead' && game.deadTime > 0.6 ) reset();

}

// drone style input in [ - 1, 1 ] for each axis: mobile sticks, or keyboard / held pointer on desktop

const _input = { forward: 0, strafe: 0, lift: false, turn: 0 };

function readInput() {

	if ( isMobile ) {

		_input.forward = touch.forward;
		_input.strafe = touch.strafe;
		_input.turn = touch.turn;
		_input.lift = touch.lift;
		return;

	}

	const axis = ( positive, negative ) => ( keys.has( positive ) ? 1 : 0 ) - ( keys.has( negative ) ? 1 : 0 );

	_input.forward = THREE.MathUtils.clamp( axis( 'KeyW', 'KeyS' ) + axis( 'ArrowUp', 'ArrowDown' ), - 1, 1 );
	_input.strafe = axis( 'KeyD', 'KeyA' );
	_input.turn = axis( 'ArrowRight', 'ArrowLeft' );
	_input.lift = keys.has( 'Space' ); // the only way up, gravity does the rest

	if ( pointer.down ) {

		// holding the pointer flies forward, its position steers

		_input.forward = 1;
		_input.turn = THREE.MathUtils.clamp( pointer.x * 1.5, - 1, 1 );
		_input.lift = pointer.y > 0.25; // upper part of the screen

	}

}

function createBird() {

	const group = new THREE.Group();
	group.rotation.order = 'YZX'; // heading first, then pitch, then bank

	const body = new THREE.Mesh( new THREE.SphereGeometry( BIRD_RADIUS, 24, 16 ), new THREE.MeshStandardMaterial( { color: 0xffd23f, roughness: 0.6 } ) );
	body.scale.set( 1.2, 1, 1 );
	group.add( body );

	const beak = new THREE.Mesh( new THREE.ConeGeometry( 0.5, 1.2, 12 ), new THREE.MeshStandardMaterial( { color: 0xff7b24 } ) );
	beak.rotation.z = Math.PI / 2;
	beak.position.set( - 2.1, - 0.1, 0 );
	group.add( beak );

	const eyeGeometry = new THREE.SphereGeometry( 0.28, 12, 8 );
	const eyeMaterial = new THREE.MeshStandardMaterial( { color: 0x111111, roughness: 0.2 } );

	wings = [];

	for ( const side of [ - 1, 1 ] ) {

		const eye = new THREE.Mesh( eyeGeometry, eyeMaterial );
		eye.position.set( - 1.1, 0.55, side * 0.95 );
		group.add( eye );

		// the pivot sits at the shoulder so the wing rotates around it

		const pivot = new THREE.Group();
		pivot.position.set( 0.2, 0.2, side * 1.2 );

		const wing = new THREE.Mesh( new THREE.BoxGeometry( 1.6, 0.25, 2.2 ), body.material );
		wing.position.z = side * 1.1;
		pivot.add( wing );

		group.add( pivot );
		wings.push( { pivot, side } );

	}

	group.traverse( function ( object ) {

		if ( object.isMesh ) object.castShadow = true;

	} );

	return group;

}

function init() {

	scene = new THREE.Scene();
	scene.fog = new THREE.Fog( 0x000000, 500, 4000 );
	scene.environmentIntensity = 0.5;

	camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.5, 5000 );

	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setAnimationLoop( animate );
	renderer.shadowMap.enabled = true;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.6;
	document.body.appendChild( renderer.domElement );

	timer = new THREE.Timer();
	pmremGenerator = new THREE.PMREMGenerator( renderer );
	sceneEnv = new THREE.Scene();

	// sky and sun

	sky = new Sky();
	sky.scale.setScalar( 9000 );
	scene.add( sky );

	sky.material.uniforms.turbidity.value = 3;
	sky.material.uniforms.rayleigh.value = 2;
	sky.material.uniforms.showSunDisc.value = false; // the sun is represented by the light

	sunLight = new SunLight();
	sunLight.castShadow = true;
	sunLight.shadow.camera.far = 600; // maximum shadow distance
	sunLight.shadow.mapSize.setScalar( 2048 );
	sunLight.shadow.normalBias = 0.05;
	scene.add( sunLight );

	// ground

	const ground = new THREE.Mesh( new THREE.PlaneGeometry( 10000, 10000 ), new THREE.MeshStandardMaterial( { color: 0xa39f8e } ) );
	ground.rotation.x = - Math.PI / 2;
	ground.receiveShadow = true;
	scene.add( ground );

	// the limit of the arena, drawn as a faint wireframe shell

	const dome = new THREE.Mesh(
		new THREE.SphereGeometry( ARENA_RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2 ),
		new THREE.MeshBasicMaterial( { color: 0x3fb8ff, wireframe: true, transparent: true, opacity: 0.18, fog: false } )
	);
	scene.add( dome );

	createBlocks();
	createTowers();

	// the ring and its beacon glow, so they ignore lighting and tone mapping

	const glow = new THREE.MeshBasicMaterial( { color: 0xff4d00, toneMapped: false } );

	ring = new THREE.Mesh( new THREE.TorusGeometry( RING_RADIUS, 0.7, 12, 48 ), glow );
	scene.add( ring );

	beacon = new THREE.Mesh(
		new THREE.CylinderGeometry( 3, 3, ARENA_RADIUS, 24, 1, true ),
		new THREE.MeshBasicMaterial( { color: 0xff4d00, toneMapped: false, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide } )
	);
	scene.add( beacon );

	blood = new THREE.InstancedMesh( new THREE.SphereGeometry( 1, 10, 8 ), new THREE.MeshStandardMaterial( { color: 0x9c0505, roughness: 0.25 } ), BLOOD_COUNT );
	blood.castShadow = true;
	blood.receiveShadow = true;
	blood.frustumCulled = false; // the drops move every frame
	scene.add( blood );

	for ( let i = 0; i < BLOOD_COUNT; i ++ ) {

		drops.push( { position: new THREE.Vector3(), velocity: new THREE.Vector3(), size: 1, landed: false } );

	}

	bird = createBird();
	scene.add( bird );

	reset();

	camera.position.set( start.x + 22, start.y + 7, start.z ); // start where the chase camera settles

	// handle for poking at the game from the console during development

	if ( import.meta.env.DEV ) window.flappy = { game, bird, velocity, ring, drops, blockList, touchesBlock };

	bindControls();

}

function bindStick( element, knob, onChange ) {

	const state = { id: null, x: 0, y: 0 };
	const maxRadius = () => element.clientWidth * 0.38;

	function setKnob( x, y ) {

		knob.style.transform = 'translate(' + x + 'px,' + y + 'px)';

	}

	function updateFromEvent( event ) {

		const rect = element.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		let dx = event.clientX - cx;
		let dy = event.clientY - cy;
		const limit = maxRadius();
		const length = Math.hypot( dx, dy );

		if ( length > limit ) {

			dx *= limit / length;
			dy *= limit / length;

		}

		state.x = dx / limit;
		state.y = dy / limit;
		setKnob( dx, dy );
		onChange( state.x, state.y );

	}

	function end() {

		state.id = null;
		state.x = 0;
		state.y = 0;
		setKnob( 0, 0 );
		onChange( 0, 0 );

	}

	element.addEventListener( 'pointerdown', function ( event ) {

		event.preventDefault();
		event.stopPropagation();
		element.setPointerCapture( event.pointerId );
		state.id = event.pointerId;
		updateFromEvent( event );
		begin();

	} );

	element.addEventListener( 'pointermove', function ( event ) {

		if ( state.id !== event.pointerId ) return;
		event.preventDefault();
		updateFromEvent( event );

	} );

	for ( const type of [ 'pointerup', 'pointercancel', 'lostpointercapture' ] ) {

		element.addEventListener( type, function ( event ) {

			if ( state.id !== null && event.pointerId !== state.id ) return;
			end();

		} );

	}

}

function bindMobileControls() {

	mobileControls.classList.add( 'active' );

	bindStick( document.getElementById( 'move-stick' ), document.getElementById( 'move-knob' ), function ( x, y ) {

		touch.strafe = THREE.MathUtils.clamp( x, - 1, 1 );
		touch.forward = THREE.MathUtils.clamp( - y, - 1, 1 );

	} );

	bindStick( document.getElementById( 'turn-stick' ), document.getElementById( 'turn-knob' ), function ( x ) {

		touch.turn = THREE.MathUtils.clamp( x, - 1, 1 );

	} );

	function setLift( down ) {

		const wasDown = touch.lift;
		touch.lift = down;
		liftButton.classList.toggle( 'active', down );

		if ( down && ! wasDown ) {

			begin();
			velocity.y = Math.max( velocity.y, JUMP );

		}

	}

	liftButton.addEventListener( 'pointerdown', function ( event ) {

		event.preventDefault();
		event.stopPropagation();
		liftButton.setPointerCapture( event.pointerId );
		setLift( true );

	} );

	for ( const type of [ 'pointerup', 'pointercancel', 'lostpointercapture' ] ) {

		liftButton.addEventListener( type, function () {

			setLift( false );

		} );

	}

	renderer.domElement.addEventListener( 'pointerdown', function () {

		if ( game.state === 'dead' ) retry();
		else if ( game.state === 'ready' ) begin();

	} );

	window.addEventListener( 'blur', function () {

		touch.forward = touch.strafe = touch.turn = 0;
		touch.lift = false;
		liftButton.classList.remove( 'active' );

	} );

}

function bindDesktopControls() {

	const gameKeys = [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter' ];

	window.addEventListener( 'keydown', function ( event ) {

		if ( gameKeys.includes( event.code ) === false ) return;

		event.preventDefault();

		if ( event.repeat ) return;

		if ( game.state === 'dead' ) {

			if ( event.code === 'Space' || event.code === 'Enter' ) retry();
			return;

		}

		keys.add( event.code );
		begin();

		if ( event.code === 'Space' ) velocity.y = Math.max( velocity.y, JUMP );

	} );

	window.addEventListener( 'keyup', function ( event ) {

		keys.delete( event.code );

	} );

	window.addEventListener( 'blur', function () {

		keys.clear();
		pointer.down = false;

	} );

	function movePointer( event ) {

		pointer.x = ( event.clientX / window.innerWidth ) * 2 - 1;
		pointer.y = - ( event.clientY / window.innerHeight ) * 2 + 1;

	}

	renderer.domElement.addEventListener( 'pointerdown', function ( event ) {

		movePointer( event );

		if ( game.state === 'dead' ) {

			retry();
			return;

		}

		pointer.down = true;
		begin();

	} );

	window.addEventListener( 'pointermove', movePointer );

	for ( const type of [ 'pointerup', 'pointercancel' ] ) {

		window.addEventListener( type, function () {

			pointer.down = false;

		} );

	}

}

function bindControls() {

	if ( isMobile ) bindMobileControls();
	else bindDesktopControls();

	window.addEventListener( 'resize', function () {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

}

function animate() {

	timer.update();

	const delta = Math.min( timer.getDelta(), 0.05 );
	const time = timer.getElapsed();

	const position = bird.position;

	// the bird model points down -x, so that is forward at yaw 0 and screen right is -z

	_forward.set( - Math.cos( game.yaw ), 0, Math.sin( game.yaw ) );
	_right.set( - _forward.z, 0, _forward.x );

	if ( game.state === 'ready' ) {

		position.y = start.y;

	}

	if ( game.state === 'playing' ) {

		game.playTime += delta;

		// speed up at a fixed interval

		const level = Math.floor( game.playTime / SPEED_INTERVAL );

		if ( level !== game.speedLevel ) {

			game.speedLevel = level;
			setMessage( 'speed up!', 1.2 );

		}

		// drone style flight: the input sets a velocity which the bird eases into

		readInput();

		const speed = BASE_SPEED * speedFactor();

		game.yaw -= _input.turn * TURN_SPEED * delta;

		_wanted.set( 0, 0, 0 );
		_wanted.addScaledVector( _forward, _input.forward * speed );
		_wanted.addScaledVector( _right, _input.strafe * speed * 0.8 );

		// the vertical part is physics: gravity always pulls, holding space pushes up

		const lift = GRAVITY + ( _input.lift ? LIFT : 0 );
		const vertical = THREE.MathUtils.clamp( velocity.y + lift * delta, - MAX_FALL, MAX_RISE * Math.sqrt( speedFactor() ) );

		velocity.y = 0;
		velocity.lerp( _wanted, 1 - Math.exp( - MOVE_RESPONSE * delta ) );
		velocity.y = vertical;
		position.addScaledVector( velocity, delta );

		// limits: the ground kills, the sphere around the arena only holds the bird back

		if ( position.y < MIN_HEIGHT ) {

			position.y = MIN_HEIGHT;
			die( 'hit the floor' );

		}

		const limit = ARENA_RADIUS - BIRD_RADIUS;

		if ( position.lengthSq() > limit * limit ) {

			// slide along the shell by dropping the part of the velocity that points outwards

			_target.copy( position ).normalize();
			velocity.addScaledVector( _target, - Math.max( 0, velocity.dot( _target ) ) );
			position.setLength( limit );

		}

		// the bird turns to its heading, and pitches and banks into its movement

		bird.rotation.y = game.yaw;
		bird.rotation.z = THREE.MathUtils.damp( bird.rotation.z, - velocity.y / 45 - velocity.dot( _forward ) / 140, 10, delta );
		bird.rotation.x = THREE.MathUtils.damp( bird.rotation.x, velocity.dot( _right ) / 35 + _input.turn * 0.4, 10, delta );

		if ( game.state === 'playing' ) checkRing( delta );

		if ( game.state === 'playing' && touchesBlock( position, BIRD_RADIUS ) ) die( 'splat' );

	}

	if ( game.state === 'dead' ) game.deadTime += delta;

	if ( game.messageTime !== Infinity ) {

		game.messageTime -= delta;
		if ( game.messageTime <= 0 ) setMessage( '' );

	}

	updateInfo();

	const beat = Math.sin( time * 22 ) * 0.7;

	for ( const wing of wings ) wing.pivot.rotation.x = wing.side * beat;

	updateBlood( delta );

	// the sun sets as the score goes up

	const elevation = Math.max( SUN_DUSK, SUN_NOON - game.score );

	if ( Math.abs( elevation - game.elevation ) > 0.01 ) {

		game.elevation = THREE.MathUtils.damp( game.elevation, elevation, 1.5, delta );
		updateSun();

	}

	// chase camera behind the heading of the bird

	_target.copy( position ).addScaledVector( _forward, - 22 );
	_target.y += 7;

	camera.position.lerp( _target, 1 - Math.exp( - 5 * delta ) );

	_target.copy( position ).addScaledVector( _forward, 12 );
	camera.lookAt( _target );

	// the ring always faces the camera, so it reads as a ring from any direction

	ring.lookAt( camera.position );
	ring.scale.setScalar( 1 + Math.sin( time * 5 ) * 0.08 );

	renderer.render( scene, camera );

}
