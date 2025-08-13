import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'resources', 'Pangch-Face.ico'),
    webPreferences: {
      // preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,         // ❗ import 쓰려면 false로
      contextIsolation: true          // 보안상 true 권장
    }
  });

  // Vite에서 빌드한 파일 로드
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));  // ✅ 이 부분 수정

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');  // Vite 개발 서버 주소
    //win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
  // 필요하면 메뉴 제거
  Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);
