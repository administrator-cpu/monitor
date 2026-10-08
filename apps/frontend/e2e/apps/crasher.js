// Dies right after it starts, so PM2 restarts it in a loop (this is what the crash-loop alert is for).
console.log('crasher starting');
setTimeout(() => {
  console.error('crasher about to die');
  process.exit(3);
}, 300);
