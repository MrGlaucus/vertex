require('../app/libs/backup-safe').applyRestore(process.argv[2] || '/vertex').catch(error => {
  console.error('备份切换失败，停止启动:', error.message);
  process.exitCode = 1;
});
