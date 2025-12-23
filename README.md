# Vibource

A browser-based Git repository visualizer inspired by [Gource](https://gource.io/). Watch your project grow from the first commit with an animated tree visualization.

![Vibource](https://img.shields.io/badge/version-0.1.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Features

- **Interactive Tree Visualization**: Directories appear as branches with files as leaves, using a force-directed graph layout
- **Real-time Animation**: Watch commits unfold over time with smooth animations
- **Developer Avatars**: See contributors appear near the files they're working on
- **Playback Controls**: Play, pause, speed up (0.5x to 8x), seek through history
- **File Type Colors**: Different file types are color-coded for easy identification
- **Stats Panel**: View repository statistics, top contributors, and commit details
- **GitHub Integration**: Simply paste a repository URL or use `owner/repo` format

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/vibource.git
cd vibource

# Install dependencies
npm install

# Start the development server
npm run dev
```

### Usage

1. Open the app in your browser (default: http://localhost:5173)
2. Enter a GitHub repository URL or use the `owner/repo` format
   - Examples: `facebook/react`, `vuejs/vue`, `d3/d3`
3. Optionally add a GitHub token for private repos or higher API limits
4. Click "Visualize" and watch your repository come to life!

### Building for Production

```bash
npm run build
npm run preview
```

## How It Works

1. **Data Fetching**: The app uses the GitHub REST API to fetch commit history and file changes
2. **Tree Construction**: Files are organized into a hierarchical tree structure
3. **Visualization**: D3.js renders an interactive force-directed graph
4. **Animation**: Commits are played back chronologically, showing files being added, modified, or removed

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **D3.js** - Data visualization
- **Lucide React** - Icons

## API Rate Limits

GitHub's API has rate limits:
- **Unauthenticated**: 60 requests/hour
- **Authenticated**: 5,000 requests/hour

For larger repositories, adding a GitHub Personal Access Token is recommended.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| Left Arrow | Previous commit |
| Right Arrow | Next commit |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Gource](https://gource.io/) by Andrew Caudwell
- Built with [D3.js](https://d3js.org/) by Mike Bostock
