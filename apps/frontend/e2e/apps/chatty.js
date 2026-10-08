// Prints a numbered line every 200 ms and an error line every fifth.
let i = 0;
setInterval(() => {
  console.log('chatty line ' + i++);
  if (i % 5 === 0) console.error('chatty error ' + i);
}, 200);
