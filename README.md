# One Video Cutter 🍌

One Video Cutter is a lightweight, portable, and high-performance video editing tool designed for quick clipping and audio management. Built with Go and React using the Wails framework, it provides a seamless desktop experience with the power of FFmpeg under the hood.

![One Video Cutter Banner](https://raw.githubusercontent.com/yeahuichen/onevideocutter/main/build/appicon.png)

## ✨ Features

- **🚀 High-Performance Clipping**: Efficiently cut and merge video segments without quality loss using "Stream Copy" or re-encode with high-quality codecs.
- **🕒 Interactive Timeline**: Visual timeline for precise segment selection, dragging, and batch deletion.
- **🎵 Flexible Audio Management**: 
  - Keep the original track.
  - Mute the video completely.
  - Replace with a custom audio file (MP3, AAC, etc.).
- **📦 Automated FFmpeg Management**: No manual installation required. The app automatically detects, downloads, and sets up FFmpeg for you.
- **🎨 Modern UI**: A minimalist, "banana-themed" premium aesthetic built with modern web technologies.
- **📁 Multi-Format Support**: Supports MP4, MOV, MKV, AVI, WebM, and more.
- **⚙️ Advanced Export Settings**: Choose your codec (H.264, H.265, VP9), bitrate, and output format.

## 🚀 Quick Start

1. **Download**: Grab the latest `onevideocutter.exe` from the [Releases](https://github.com/yeahuichen/onevideocutter/releases) page.
2. **Open Video**: Launch the app and select your video file.
3. **Clip & Edit**:
   - Use the timeline to add clip points (`+` button or Right Click).
   - Double-click segments to mark them for deletion.
   - Drag clip points to adjust timing.
4. **Export**: Choose your settings and hit "Export". The app will handle the rest!

## 🛠️ Tech Stack

- **Backend**: [Go](https://golang.org/)
- **Frontend**: [React](https://reactjs.org/) + [Vite](https://vitejs.dev/)
- **Framework**: [Wails v2](https://wails.io/)
- **Core Engine**: [FFmpeg](https://ffmpeg.org/)
- **Styling**: Vanilla CSS with a custom design system.

## 🏗️ Development

### Prerequisites
- Go 1.20+
- Node.js & NPM
- [Wails CLI](https://wails.io/docs/gettingstarted/installation)

### Run in Development Mode
```bash
wails dev
```

### Build for Production
```bash
wails build
```

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

Created with ❤️ by [yeahuichen](https://github.com/yeahuichen)
