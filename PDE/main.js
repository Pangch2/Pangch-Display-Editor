const path = require('path');
const { app, BrowserWindow } = require('electron');

if (process.env.NODE_ENV !== 'production') {
  // 이 부분이 개발 중에 파일 변경 감지 후 자동 재시작 담당
  require('electron-reload')(path.join(__dirname), {
    electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit',
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
