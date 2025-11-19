# AR Modal Viewer with Light Estimation and Multiplayer Support

This project is an augmented reality (AR) application built using Three.js and WebXR, featuring dynamic light estimation, multiplayer interaction, and deployment on both Render and Vercel. The application displays modals in AR and includes robust support for devices that do not have `light-estimation` capabilities.

---

## Features

- **Dynamic Light Estimation**: Adjusts scene lighting based on real-world ambient light (if supported).
- **Fallback Lighting**: Adds directional light for environments where light estimation is unavailable.
- **AR Modals**: Displays dynamically positioned message modals in AR.
- **Multiplayer Support**: Share the AR experience in real time across multiple users.
- **Text Rendering**: Dynamically rendered text on modals with support for multi-line messages.
- **Cloud Deployment**:
  - **Render**: Deployed with `npm install` and started using `node server.js`.
  - **Vercel**: Deployed for frontend AR experiences using `npx vercel dev` or `vercel` commands.

---

## Technologies Used

- **Three.js**: For rendering 3D objects and AR scenes.
- **WebXR API**: To enable AR functionality in supported browsers.
- **Socket.IO**: For real-time multiplayer communication.
- **CanvasTexture**: For rendering dynamic text on modals.
- **Render**: Backend deployment platform.
- **Vercel**: Frontend deployment platform.

---

## Getting Started

### Prerequisites

Ensure you have the following installed:
- **Node.js**: To run the server and client locally.
- A modern browser with WebXR support (e.g., Chrome or Edge).
- A device with AR capabilities (e.g., Android or iOS with ARCore or ARKit).

### Installation

#### Clone the repository:
```bash
git clone https://github.com/shashank-cr07/ar-jenga-final.git
cd ar-jenga-final
