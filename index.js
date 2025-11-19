import * as THREE from './node_modules/three/src/Three.js';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import * as CANNON from 'cannon-es';
import { XREstimatedLight } from 'three/examples/jsm/Addons.js';

// Core variables
let container, camera, scene, renderer;
let controller, reticle;
let hitTestSource = null;
let hitTestSourceRequested = false;
let blockTexture = null;
let startButton;
let gameStarted = false;
let lastCollapseCheckTime = 0;
let basePosition;
let isReady = false;
let canMove = false;  //for player-turn based movement
let roomId = null;
let messageVisible = false;  //to prevent overwriting of the turn based pop up text
let modalMesh; // Mesh for the modal
let modalTextMesh; // Text mesh for the modal message
let model, modelBody; 
let groundMesh, groundBody; //ground objects 
const clock = new THREE.Clock();

//variables for the jenga tower
const cubes = [];
const cubeBodies = [];
const cubeHeight = 0.05; // Height of the cuboid
const spacing = 0.001; // Minimal spacing between layers
const baseWidth = 0.1; // Base width of the cuboid
const baseDepth = 3 * baseWidth + spacing; // Base depth of the cuboid
let levels = window.baseHeight; // Number of levels based on the user
let selectedBlock = null;  //for movement and disabling physics for that object 
let selectedBlockInitialQuaternion = null; // To store the block's orientation
// Function to create a modal in AR which will be used to display messages (turn /won/loss)
function createARModal(message) {
    if (modalMesh) {
        scene.remove(modalMesh);
        modalMesh = null;
    }
    messageVisible = true;
    const modalGeometry = new THREE.PlaneGeometry(0.5, 0.3);
    const modalMaterial = new THREE.MeshBasicMaterial({
        color: 0x707070,
        transparent: true,
        opacity: 0.9,
    });
    modalMesh = new THREE.Mesh(modalGeometry, modalMaterial);
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    const cameraDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const modalPosition = cameraPosition.clone().add(cameraDirection.multiplyScalar(1.5));
    modalPosition.y += 0.8;
    modalPosition.z += 0.5;
    modalMesh.position.copy(modalPosition);
    modalMesh.lookAt(cameraPosition);
    scene.add(modalMesh);

    // Split message into two lines dynamically
    const maxCharsPerLine = 30; // Adjust this value based on canvas width
    let line1 = message;
    let line2 = "";

    if (message.length > maxCharsPerLine) {
        const breakIndex = message.lastIndexOf(" ", maxCharsPerLine); // Find the nearest space
        line1 = message.slice(0, breakIndex);
        line2 = message.slice(breakIndex + 1);
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = 512;
    canvas.height = 256;
    // Set background color
    context.fillStyle = "#ffffff"; // Light gray to match the modal color
    context.fillRect(0, 0, canvas.width, canvas.height);

    // Set text properties and draw the text
    context.fillStyle = "black"; // Text color
    context.font = "bold 24px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    // Draw the two lines of text
    context.fillText(line1, canvas.width / 2, canvas.height / 2 - 20);
    if (line2) {
        context.fillText(line2, canvas.width / 2, canvas.height / 2 + 20);
    }

    const texture = new THREE.CanvasTexture(canvas);
    const textMaterial = new THREE.MeshBasicMaterial({ map: texture });
    const textGeometry = new THREE.PlaneGeometry(0.4, 0.2);
    modalTextMesh = new THREE.Mesh(textGeometry, textMaterial);

    modalTextMesh.position.copy(modalMesh.position);
    modalTextMesh.position.z += 0.01;
    modalTextMesh.lookAt(cameraPosition);
    scene.add(modalTextMesh);
}

// Function to remove the modal from the AR scene
function removeARModal() {
    if (modalMesh) {
        scene.remove(modalMesh);
        messageVisible = false;
        modalMesh = null;
    }
    if (modalTextMesh) {
        scene.remove(modalTextMesh);
        modalTextMesh = null;
    }
}

let physicsEnabled = false; //for toggling physics 
const blockMaterial = new CANNON.Material({ friction: 10.0, restitution: 0.0 }); //adding high friction so model remains stable

// Connect to the WebSocket server
const socket = io("https://ar-jenga-final.onrender.com");   //change after deploying on render first 

//called when player clicks on the ready button 
function notifyReady() {
    if (!roomId) {
        console.error('Room ID is not set. Cannot notify readiness.');
        return;
    }
    console.log(roomId);
    socket.emit('player-ready', { roomId });
}

// Handle connection
let id = null;
//establish a socket connection 
socket.on('connect', () => {
    console.log('Connected to the server with ID:', socket.id);
    id = socket.id;
    window.id = id; // Assign to window.id after the socket is connected
    console.log('Window ID:', window.id); // Verify the assignment
});

// Handle game start
socket.on('start-game', ({ initialGameState, roomId: receivedRoomId }) => {
    if (roomId !== receivedRoomId) return; // Ignore if not for the current room

    console.log('Game started with initial state:', initialGameState);
    gameStarted = true;
    startButton.visible = false;
    reticle.visible = false;

    // Sync the initial game state
});

let res = false; //used to prevent multiple displays of text 
socket.on('game-result', ({ message, roomId: receivedRoomId, playerId }) => {
    if (roomId !== receivedRoomId) return; // Ignore if not for the current room

    if (!res) {
        // Show the AR modal instead of alert
        if (messageVisible === true) {
            removeARModal();
        }
        createARModal(message); // Display message with Player ID
        res = true;
    }

    // Log the result for debugging purposes
    console.log(`Room: ${receivedRoomId}, Player ID: ${playerId}, Message: ${message}`);
});


// Listen for block updates from the server
socket.on('update-block', ({ blockData, roomId: receivedRoomId }) => {
    if (roomId !== receivedRoomId) return; // Ignore updates for other rooms

    if (!basePosition) {
        console.warn('Base position not set. Unable to apply block updates.');
        return;
    }

    const blockIndex = blockData.id;

    // Calculate the new position
    const newPosition = {
        x: basePosition.x + blockData.relativePosition.x,
        y: basePosition.y + blockData.relativePosition.y,
        z: basePosition.z + blockData.relativePosition.z,
    };

    // Update the block
    if (blockIndex >= 0 && blockIndex < cubes.length) {
        const blockBody = cubeBodies[blockIndex];
        blockBody.position.set(newPosition.x, newPosition.y, newPosition.z);
        blockBody.quaternion.set(
            blockData.quaternion.x,
            blockData.quaternion.y,
            blockData.quaternion.z,
            blockData.quaternion.w
        );

        cubes[blockIndex].position.copy(blockBody.position);
        cubes[blockIndex].quaternion.copy(blockBody.quaternion);
        console.log(`Block with ID ${blockIndex} updated in room ${receivedRoomId}`);
    } else {
        console.warn(`Block with ID ${blockIndex} does not exist.`);
    }
});

//whenever the turn is rotated 
socket.on('turn-update', ({ currentTurn, roomId: receivedRoomId }) => {
    console.log("Turn update received for", currentTurn);

    if (roomId !== receivedRoomId) {
        console.log(`Turn update ignored: Not for this room (received: ${receivedRoomId}, current: ${roomId})`);
        return; // Ignore if not for the current room
    }

    if (id === currentTurn) {
        // Allow the current player to move
        if (canMove) return;
        canMove = true;
        if (!res) {
            if (messageVisible === true) {
                removeARModal();
            }
            createARModal("Your turn!");
        }
        console.log("YOUR TURN");
    } else {
        // Disable movement for non-current players
        canMove = false;
        if (!res) {
            if (messageVisible === true) {
                removeARModal();
            }
            createARModal("Waiting for the other player...");
        }
        console.log("Waiting for the other player's turn");
    }

    if (res) {
        canMove = true; // Reset move permission if res is true
    }

    console.log(`Turn updated: Current turn for player ${currentTurn} in room ${roomId}`);
});

const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.82, 0), // Gravity pulling objects down
});
world.solver.iterations = 50; // Increase iterations for more stable results
world.solver.tolerance = 0.01; // Set higher tolerance for a forgiving simulation

// Notify server of block movement
function notifyBlockMovement(blockBody, blockIndex) {
    const blockData = {
        id: blockIndex,
        position: {
            x: blockBody.position.x,
            y: blockBody.position.y,
            z: blockBody.position.z,
        },
        quaternion: {
            x: blockBody.quaternion.x,
            y: blockBody.quaternion.y,
            z: blockBody.quaternion.z,
            w: blockBody.quaternion.w,
        },
    };

    socket.emit('update-block', { roomId, blockData });
}

//whenever the user clicks to remove the ar message 
function onControllerSelect() {
    if (messageVisible)
        removeARModal(); // Remove the AR modal
}

document.addEventListener('DOMContentLoaded', () => {

    const startButton1 = document.getElementById('start-game');
    //done so user can enter AR only after he has clicked on start AR
    startButton1.addEventListener('click',
        () => {

            roomId = window.roomId;  //taking room id from window as changed in index.html

            // Ensure roomId is available
            if (!roomId) {
                console.error('Room ID is not available. Ensure you have joined or created a room.');
            } else {
                console.log(`Using Room ID: ${roomId}`);
            }

            init();
            animate();
            //adding the Ready? ar message when the model has loaded and notifies that the player is ready to start the game 
            function createStartButton() {
                // Create a floating panel for the button
                const geometry = new THREE.PlaneGeometry(0.4, 0.15);
                const material = new THREE.MeshBasicMaterial({
                    color: 0x44cc44,
                    transparent: true,
                    opacity: 0.8,
                    roughness: 0.5, // Slightly shiny
                    metalness: 0.1, // Minimal metallic effect
                    side: THREE.DoubleSide,
                });
                startButton = new THREE.Mesh(geometry, material);
                // Add text to the button
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = 256;
                canvas.height = 128;
                // Style the text
                context.fillStyle = '#000000';
                context.font = 'bold 48px Arial';
                context.textAlign = 'center';
                context.textBaseline = 'middle';
                context.fillText('Ready?', canvas.width / 2, canvas.height / 2);
                // Create texture from canvas
                const texture = new THREE.CanvasTexture(canvas);
                const textGeometry = new THREE.PlaneGeometry(0.35, 0.12);
                const textMaterial = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    side: THREE.DoubleSide
                });
                const textMesh = new THREE.Mesh(textGeometry, textMaterial);
                textMesh.position.z = 0.001; // Slightly in front of the button
                startButton.add(textMesh);
                // Adding the ready button to scene
                scene.add(startButton);
            }

            //init function that runs first when page is loaded in ar
            function init() {
                // Create the container
                container = document.createElement('div');
                document.body.appendChild(container);
                // Create the scene
                scene = new THREE.Scene();
                createStartButton(); //calling the ready button 
                startButton.visible = false;  //setting it to false since we want it hidden till the user has loaded his model
                // Set up camera
                camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
              
                // Renderer setup
                renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
                renderer.setSize(window.innerWidth, window.innerHeight);
                renderer.setPixelRatio(window.devicePixelRatio);
                renderer.xr.enabled = true;
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Soft shadows for better quality
                container.appendChild(renderer.domElement);

                //using xr estimated light so we can have better visuals 
                const xrLight = new XREstimatedLight(renderer);
                //event listmer for the estimated light 
                xrLight.addEventListener('estimationstart', () => {
                    scene.add(xrLight);
                    if (xrLight.environment) {
                        scene.environment = xrLight.environment;
                    }
                });
                //adding a event listen to remove when the estimation has ended 
                xrLight.addEventListener('estimationend', () => {
                    scene.remove(xrLight);
                    scene.environment = null;
                    // Add a fallback directional light
                    addFallbackLight();
                });

                //if the user does not have acess to xr estimated light as in laptop devices then we add a directional light 
                //if it is not supported by user device
                if (!xrLight.intensity) {
                    addFallbackLight();
                }
                function addFallbackLight() {
                    // Check if a fallback light already exists to avoid adding multiple lights
                    if (scene.getObjectByName("fallbackDirectionalLight")) {
                        return;
                    }
                    const fallbackLight = new THREE.DirectionalLight(0xffffff, 1.0);
                    fallbackLight.name = "fallbackDirectionalLight";
                    fallbackLight.position.set(5, 10, 5); // Position the light
                    fallbackLight.castShadow = true; // Enable shadows
                  
                    // Set shadow properties for better quality
                    fallbackLight.shadow.mapSize.width = 1024;
                    fallbackLight.shadow.mapSize.height = 1024;
                    fallbackLight.shadow.camera.near = 0.5;
                    fallbackLight.shadow.camera.far = 50;
                  
                    scene.add(fallbackLight);
                    console.log("Fallback directional light added");
                }
              
                // Add AR button for WebXR that takes hit-test and light estimation 
                const arButton = ARButton.createButton(renderer, { requiredFeatures: ['hit-test'], optionalFeatures: ['light-estimation'] });
                arButton.style.position = 'fixed';
                arButton.style.bottom = '10px';
                arButton.style.left = '50%';
                arButton.style.transform = 'translateX(-50%)';
                document.body.appendChild(arButton);
                //done so user is directly redirected to AR 
                setTimeout(() => {
                    arButton.click();
                    console.log("AR button clicked programmatically.");
                }, 0);
              
                // Reticle for hit-testing
                reticle = new THREE.Mesh(
                    new THREE.RingGeometry(0.1, 0.15, 32).rotateX(-Math.PI / 2),
                    new THREE.MeshBasicMaterial({ color: 0x00ff00 }) //green color reticle for block placement 
                );
                reticle.matrixAutoUpdate = false;
                reticle.visible = false;
                scene.add(reticle);
              
                // Set up the ground plane (visual and physics)
                const groundSize = 1.5;
                const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize);
                const groundMaterial = new THREE.MeshStandardMaterial({
                    color: 0x008800,
                    side: THREE.DoubleSide,
                });
                groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
                groundMesh.rotation.x = -Math.PI / 2;  //to make the ground flat
                groundMesh.receiveShadow = true; //making it capable of recieving shadows 
                groundMesh.visible = false;  //make it initially hidden till the user has loaded it 
                scene.add(groundMesh);
                const groundPhysicsMaterial = new CANNON.Material({ friction: 10.0, restitution: 0.0 });

                // Create the ground body in Cannon.js
                const groundShape = new CANNON.Box(new CANNON.Vec3(groundSize / 2, 0.01, groundSize / 2));
                groundBody = new CANNON.Body({
                    mass: 0, // Static body
                    shape: groundShape,
                    material: groundPhysicsMaterial,
                });
                groundBody.receiveShadow = true;
                world.addBody(groundBody);
              
                // Add contact material between block and ground
                world.addContactMaterial(
                    new CANNON.ContactMaterial(blockMaterial, groundPhysicsMaterial, {
                        friction: 10.0, // High friction
                        restitution: 0.0, // No bounce
                    })
                );

                // Add contact material for block-to-block interactions
                world.addContactMaterial(
                    new CANNON.ContactMaterial(blockMaterial, blockMaterial, {
                        friction: 10.0, // High friction between blocks
                        restitution: 0.0, // No bounce
                    })
                );

                //loading the texture from the public folder 
                //you can add any picture of your choice 
                const textureLoader = new THREE.TextureLoader();
                textureLoader.load('/wood.jpg', () => {
                    blockTexture = textureLoader.load('/wood.jpg', () => { });
                    console.log('Texture loaded successfully');
                }, undefined, (error) => {
                    console.error('Error loading texture:', error);
                });

                // Set up the controller for interaction
                controller = renderer.xr.getController(0);
                controller.addEventListener('select', onSelect);  //for placing reticle 
                controller.addEventListener("select", onControllerSelect); //for the removal of the text message in the ar
                scene.add(controller);

                // Handle window resize
                window.addEventListener('resize', onWindowResize);

                //event listners
                window.addEventListener('keydown', onKeyDown);
                // Add event listeners for both pointer and touch inputs
                window.addEventListener('pointerdown', onInteractionStart);
                window.addEventListener('pointermove', onInteractionMove);
                window.addEventListener('pointerup', onInteractionEnd);

                // Touch-specific listeners for mobile devices
                window.addEventListener('touchstart', onInteractionStart);
                window.addEventListener('touchmove', onInteractionMove);
                window.addEventListener('touchend', onInteractionEnd);
            }

            function isTowerCollapsed() {
                // Thresholds for collapse detection
                const displacementThreshold = 0.3; // Maximum distance a block can move before being considered "out of place"
                const rotationThreshold = 0.3; // Maximum quaternion deviation (angular threshold)
                let collapsedCount = 0;  //counting no of collapsed blocks 
                // Iterate through all blocks
                for (let i = 0; i < cubes.length; i++) {
                    const cube = cubes[i];
                    const cubeBody = cubeBodies[i];
                  
                    // Original position and rotation
                    const originalPosition = cubeBody.initPosition; // Assume you saved this during initialization
                    const originalQuaternion = cubeBody.initQuaternion; // Assume you saved this during initialization

                    // Calculate displacement
                    const displacement = cubeBody.position.vsub(originalPosition).length();
                    // Convert Cannon.js quaternion to THREE.js quaternion
                    const currentQuaternion = new THREE.Quaternion(
                        cubeBody.quaternion.x,
                        cubeBody.quaternion.y,
                        cubeBody.quaternion.z,
                        cubeBody.quaternion.w
                    );
                    // Calculate rotation difference (quaternion dot product gives cosine of half the angle)
                    const rotationDifference = Math.abs(currentQuaternion.dot(originalQuaternion) - 1);
                    // Check if block is out of place
                    if (displacement > displacementThreshold || rotationDifference > rotationThreshold) {
                        collapsedCount++;
                    }
                }
                // If a significant number of blocks are out of place, consider the tower collapsed
                const collapseRatio = collapsedCount / cubes.length;
                return collapseRatio > 0.3; // Adjust this value to control sensitivity
            }

            //storing the tower state 
            function initializeTowerState() {
                for (let i = 0; i < cubeBodies.length; i++) {
                    cubeBodies[i].initPosition = cubeBodies[i].position.clone(); // Store initial position
                    cubeBodies[i].initQuaternion = cubeBodies[i].quaternion.clone(); // Store initial orientation
                }
            }
            //checking if the tower is collapsed
            //this must keep checking hence it is present in the animate function 
            function checkTowerState() {
                if (isTowerCollapsed()) {
                    // Notify the server that the tower has collapsed with the player's ID
                    socket.emit('tower-collapsed', {
                        roomId,
                        playerId: id,
                    });
                    console.log("Tower has collapsed");
                }
            }

            //highlighting the selected block
            function highlightBlock(block) {
                if (block) {
                    if (!block.material.__originalColor) {
                        // Store the original color only once
                        block.material.__originalColor = block.material.color.clone();
                    }
                    block.material.color.set(0x00FFFA); // Highlight with a light blue colour
                    block.material.needsUpdate = true;
                }
            }
            //removing the highlight once the block movent was done 
            function resetHighlight(block) {
                if (block && block.material.__originalColor) {
                    // Restore the original color
                    block.material.color.copy(block.material.__originalColor);
                    block.material.needsUpdate = true;
                }
            }
            // Keydown event to move the block
            function onKeyDown(event) {
                if (!selectedBlock || !gameStarted || !canMove) return;
                const blockPosition = selectedBlock.position;
                const movementStep = 0.01;
              
                switch (event.key.toLowerCase()) {
                    case 'w': blockPosition.y += movementStep; break;
                    case 's': blockPosition.y -= movementStep; break;
                    case 'a': blockPosition.x -= movementStep; break;
                    case 'd': blockPosition.x += movementStep; break;
                    case 'r':
                        selectedBlock.mass = 1;
                        selectedBlock.fixedRotation = false;
                        selectedBlock.updateMassProperties();
                        const index = cubeBodies.indexOf(selectedBlock);
                        if (index >= 0) {
                            cubes[index].position.copy(blockPosition);
                            notifyBlockMovement(selectedBlock, index);
                            resetHighlight(cubes[index]);
                        }
                        selectedBlock = null;
                        return;
                    default: break;
                }
            }
            let isTouching = false; // Track if the user is interacting
            let touchStart = null; // Track the initial pointer or touch position
            // Unified event for pointer or touch start
            function onInteractionStart(event) {
                if (!gameStarted || !canMove) return;  //if its not the users turn canMove will be false
                // Handle both touch and pointer events
                const pointer = new THREE.Vector2();
                if (event.touches) {
                    // Touch event
                    const touch = event.touches[0];
                    pointer.set(
                        (touch.clientX / window.innerWidth) * 2 - 1,
                        -(touch.clientY / window.innerHeight) * 2 + 1
                    );
                } else {
                    // Pointer event
                    pointer.set(
                        (event.clientX / window.innerWidth) * 2 - 1,
                        -(event.clientY / window.innerHeight) * 2 + 1
                    );
                }
                // Raycast to detect objects
                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(pointer, camera);
                const intersects = raycaster.intersectObjects(cubes);
                if (intersects.length > 0) {
                    const intersectedMesh = intersects[0].object;
                    const index = cubes.indexOf(intersectedMesh);

                    if (index >= 0) {
                        const newSelectedBlock = cubeBodies[index];

                        if (newSelectedBlock) {
                            // Highlight the block
                            selectedBlock = newSelectedBlock;
                            highlightBlock(intersectedMesh);
                            // Prepare the block for movement
                            selectedBlockInitialQuaternion = selectedBlock.quaternion.clone();
                            selectedBlock.mass = 0; // Disable physics
                            selectedBlock.fixedRotation = true; // Lock rotation
                            selectedBlock.updateMassProperties();
                            // Track the touch start
                            touchStart = pointer.clone();
                            isTouching = true;
                        }
                    }
                }
            }
            // Unified event for pointer or touch move
            function onInteractionMove(event) {
                if (!isTouching || !selectedBlock || !canMove) return; //if no block is chosen or its not the users turn to move
                // Handle both touch and pointer events
                const pointer = new THREE.Vector2();
                if (event.touches) {
                    // Touch event
                    const touch = event.touches[0];
                    pointer.set(
                        (touch.clientX / window.innerWidth) * 2 - 1,
                        -(touch.clientY / window.innerHeight) * 2 + 1
                    );
                } else {
                    // Pointer event
                    pointer.set(
                        (event.clientX / window.innerWidth) * 2 - 1,
                        -(event.clientY / window.innerHeight) * 2 + 1
                    );
                }
                if (touchStart) {
                    // Calculate movement delta
                    const delta = new THREE.Vector2(
                        pointer.x - touchStart.x,
                        pointer.y - touchStart.y
                    );
                    // Translate the block based on delta
                    selectedBlock.position.x += delta.x * 0.5; // Adjust sensitivity
                    selectedBlock.position.z += delta.y * 0.5; // Adjust sensitivity
                    // Update touchStart for the next move
                    touchStart = pointer.clone();
                    // Sync the mesh with the body
                    const index = cubeBodies.indexOf(selectedBlock);
                    if (index >= 0) {
                        cubes[index].position.copy(selectedBlock.position);
                    }
                }
            }
            // Unified event for pointer or touch end
            function onInteractionEnd() {
                if (!isTouching || !selectedBlock || !canMove) return;
                // Release the block back into physics
                selectedBlock.mass = 1;
                selectedBlock.fixedRotation = false;
                selectedBlock.updateMassProperties();
                // Ensure the block maintains its orientation when released
                if (selectedBlockInitialQuaternion) {
                    selectedBlock.quaternion.copy(selectedBlockInitialQuaternion);
                    const index = cubeBodies.indexOf(selectedBlock);
                    if (index >= 0) cubes[index].quaternion.copy(selectedBlockInitialQuaternion);
                }
              
                // Reset highlight and clear selection
                const index = cubeBodies.indexOf(selectedBlock); //chosing the index of the selected block
                if (index >= 0) {
                    notifyBlockMovement(selectedBlock, index);
                    resetHighlight(cubes[index]);
                }
                selectedBlock = null;
                selectedBlockInitialQuaternion = null;
                isTouching = false;
                touchStart = null;
            }
            //for window resize 
            function onWindowResize() {
                camera.aspect = window.innerWidth / window.innerHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(window.innerWidth, window.innerHeight);
            }

            //One of the main functions in this code
            //used to generate the jenga tower at a particular position
            //async function since time interval at each layer generation for a smooth animation 
            async function createLayersAtPosition(basePosition) {
                physicsEnabled = false; // Temporarily disable physics updates during creation
                levels = window.baseHeight; // Number of levels
                for (let level = 0; level < levels; level++) {
                    const cubeWidth = level % 2 === 0 ? baseWidth : baseDepth; // Alternate width
                    const cubeDepth = level % 2 === 0 ? baseDepth : baseWidth; // Alternate depth
                    const baseMass = 1; // Base mass for the bottom layer
                    const mass = baseMass * (1 - level / levels); // Reduce mass as the layers go higher
                    physicsEnabled = false; // Temporarily disable physics updates during creation

                    for (let i = 0; i < 3; i++) {
                        let x = basePosition.x + (i - 1) * (cubeWidth + spacing); // Horizontal positioning
                        const y = basePosition.y + cubeHeight / 2 + level * cubeHeight; // Vertical positioning
                        let z = basePosition.z;

                        if (level % 2 === 1) {
                            // Alternate alignment for odd layers since in jenga each layer is rotated by 90 
                            x = basePosition.x;
                            z = basePosition.z + (i - 1) * (cubeDepth + spacing);
                        }
                        // Create Three.js Mesh
                        const blockMaterial2 = new THREE.MeshStandardMaterial({
                            map: blockTexture || null, // Use blockTexture if available, otherwise no texture
                            color: blockTexture ? null : 0xB78319, // Fallback to blue if blockTexture is undefined
                        });
                        const cubeMesh = new THREE.Mesh(
                            new THREE.BoxGeometry(cubeWidth, cubeHeight, cubeDepth),
                            blockMaterial2.clone()
                        );
                        cubeMesh.position.set(x, y, z);
                        // Enable shadows for the cube
                        cubeMesh.castShadow = true;
                        cubeMesh.receiveShadow = true; // The cube will receive shadows
                        scene.add(cubeMesh);
                        cubes.push(cubeMesh);
                        cubeMesh.visible = true;
                      
                        // Create Cannon.js Body
                        const cubeBody = new CANNON.Body({
                            mass: Math.max(mass, 0.1), // Ensure a minimum mass
                            shape: new CANNON.Box(new CANNON.Vec3(cubeWidth / 2, cubeHeight / 2, cubeDepth / 2)),
                            position: new CANNON.Vec3(x, y, z),
                            material: blockMaterial,
                            linearDamping: 0.2, // Increase damping for more stability
                            angularDamping: 0.2,
                        });
                        console.log(x, y, z);
                        world.addBody(cubeBody);
                        cubeBodies.push(cubeBody);
                        console.log(`Cube created at position: (${x}, ${y}, ${z})`);
                    }
                    // Wait briefly before adding the next layer to ensure proper placement
                    physicsEnabled = true;
                    await new Promise((resolve) => setTimeout(resolve, 300)); // Shorter delay for smoother stacking
                }
                // Re-enable physics after creation
                physicsEnabled = false;
                startButton.visible = true; //making the start button visible after the tower has been loaded 
            }
          
            //for multiple placements of the tower 
            function placeTowerAtReticle(position) {
                // Clear the previous tower and related objects
                clearPreviousTower();
                // Build the Jenga tower at the new position
                createLayersAtPosition(position);
                console.log('Tower placed at:', position);
                socket.emit('set-base-position', {
                    roomId,
                    position: {
                        x: position.x,
                        y: position.y,
                        z: position.z,
                    },
                });
                basePosition = position;
            }
            //removing a previous tower 
            function clearPreviousTower() {
                // Remove old cubes from the scene and world
                while (cubes.length > 0) {
                    const cube = cubes.pop();
                    scene.remove(cube); // Remove from scene
                }

                while (cubeBodies.length > 0) {
                    const body = cubeBodies.pop();
                    world.removeBody(body); // Remove from physics world
                }

                // Clear any selected block references
                selectedBlock = null;
                selectedBlockInitialQuaternion = null;
                console.log('Previous objects cleared.');
            }

            //handling user taps/clicks 
            function onSelect() {
                if (!gameStarted) {
                    const raycaster = new THREE.Raycaster();
                    const tempMatrix = new THREE.Matrix4();

                    tempMatrix.identity().extractRotation(controller.matrixWorld);
                    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
                    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);

                    const intersects = raycaster.intersectObject(startButton, true);

                    if (intersects.length > 0) {  //done to check if the user has clicked on the ready? button indicating he is ready to start playing 
                        gameStarted = true;
                        startButton.visible = false;
                        reticle.visible = false;
                        isReady = true;
                        physicsEnabled = true;
                        console.log('Game Started!');
                        notifyReady();
                        return;
                    }
                    if (reticle.visible) {  //if the reticle is visible and the user has clicked then we load the jenga model and a plane below it 
                        const position = new THREE.Vector3();
                        const rotation = new THREE.Quaternion();
                        const scale = new THREE.Vector3();
                        reticle.matrix.decompose(position, rotation, scale);

                        // Place the ground at the reticle position
                        groundMesh.position.copy(position);
                        groundMesh.visible = true;
                        groundBody.position.set(position.x, position.y - 0.01, position.z);
                        groundBody.receiveShadow = true;

                        // Build the Jenga tower at the reticle position
                        placeTowerAtReticle(position);
                        initializeTowerState(); //loading the positions 
                    }
                }
            }
            //when a block is selected 
            function updateSelectedBlock() {
                // Ensure selectedBlock and selectedBlockInitialQuaternion are defined
                if (!selectedBlock || !selectedBlockInitialQuaternion) return;

                // Check if selectedBlock is a valid physics body in cubeBodies
                const index = cubeBodies.indexOf(selectedBlock);
                if (index === -1) return;

                // Maintain the initial orientation of the selected block
                selectedBlock.quaternion.copy(selectedBlockInitialQuaternion);
                cubes[index].quaternion.copy(selectedBlock.quaternion);

                // Sync the mesh position with the body position
                cubes[index].position.copy(selectedBlock.position);
            }
            //main animate function that keeps on running 
            function animate(timestamp, frame) {
                // Step the physics world if enabled
                if (physicsEnabled) {
                    const delta = clock.getDelta();
                    world.step(1 / 60, delta); // Fixed time step for physics
                    lastCollapseCheckTime += delta;
                    if (lastCollapseCheckTime >= 1) {
                        lastCollapseCheckTime = 0;
                        checkTowerState(); //constant check if the tower has collapsed 
                    }
                }
                // Sync Three.js meshes with Cannon.js bodies
                for (let i = 0; i < cubes.length; i++) {
                    cubes[i].position.copy(cubeBodies[i].position);
                    cubes[i].quaternion.copy(cubeBodies[i].quaternion);
                }
                // Update start button position and orientation if the game hasn't started
                if (startButton && !gameStarted) {
                    const cameraPosition = new THREE.Vector3();
                    camera.getWorldPosition(cameraPosition);
                    const cameraDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                    const buttonPosition = cameraPosition.clone().add(cameraDirection.multiplyScalar(1.5));
                    buttonPosition.y += 0.7; // Slightly above camera height
                    startButton.position.copy(buttonPosition);
                    startButton.lookAt(cameraPosition); // Face the camera
                }

                // Sync the model with its physics body
                if (model && modelBody) {
                    model.position.copy(modelBody.position);
                    model.quaternion.copy(modelBody.quaternion);
                    // Optional: Lock model orientation (e.g., 90 degrees rotation)
                    const fixedRotation = new THREE.Quaternion();
                    fixedRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
                    model.quaternion.copy(fixedRotation);
                }
                // Maintain block orientation if a block is selected
                updateSelectedBlock();
                // Sync the ground mesh with its physics body
                if (groundMesh && groundBody) {
                    groundMesh.position.copy(groundBody.position);
                }
                // AR hit-testing logic
                if (frame) {
                    handleHitTest(frame);
                }
                // Render the scene
                renderer.render(scene, camera);
            }
            // AR hit-testing logic extracted into a separate function
            function handleHitTest(frame) {
                const referenceSpace = renderer.xr.getReferenceSpace();
                const session = renderer.xr.getSession();

                if (!hitTestSourceRequested) {
                    session.requestReferenceSpace('viewer').then((viewerSpace) => {
                        session.requestHitTestSource({ space: viewerSpace }).then((source) => {
                            hitTestSource = source;
                        });
                    });

                    session.addEventListener('end', () => {
                        hitTestSourceRequested = false;
                        hitTestSource = null;
                    });

                    hitTestSourceRequested = true;
                }
                if (hitTestSource) {
                    const hitTestResults = frame.getHitTestResults(hitTestSource);

                    if (hitTestResults.length) {
                        const hit = hitTestResults[0];
                        const hitPose = hit.getPose(referenceSpace);

                        if (gameStarted) {
                            reticle.visible = false;
                        } else {
                            reticle.visible = true;
                            reticle.matrix.fromArray(hitPose.transform.matrix);
                        }
                    } else {
                        reticle.visible = false;
                    }
                }
            }
            // Initialize the animation loop only once
            renderer.setAnimationLoop(animate);
        });
});
