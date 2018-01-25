const watch = require('./client');

watch.on('first_success', (files) => {
  console.log('First success!', files);
});

watch.on('subsequent_success', (files) => {
    console.log('subsequent success!', files);
  // Your code goes here...
});

watch.on('compile_errors', () => {
  // Your code goes here...
});

watch.start('--watch', './example/main.ts');

try {
  // do something...
} catch (e) {
  watch.kill(); // Fatal error, kill the compiler instance.
}