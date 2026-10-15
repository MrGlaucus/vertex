const queues = new Map();

async function run (key, limit, action) {
  if (!queues.has(key)) queues.set(key, { active: 0, waiting: [] });
  const queue = queues.get(key);
  if (queue.waiting.length >= 100) throw new Error('请求队列已满，请稍后再试');
  if (queue.active >= limit) await new Promise(resolve => queue.waiting.push(resolve));
  else queue.active++;
  try {
    return await action();
  } finally {
    const next = queue.waiting.shift();
    if (next) next();
    else {
      queue.active--;
      if (!queue.active) queues.delete(key);
    }
  }
}

module.exports = { run };

// Measure queue time separately: waiting for a slot is not a network timeout.
module.exports.request = async function (options, action) {
  const queued = Date.now();
  return run(new URL(options.url).origin, 4, async () => {
    const started = Date.now();
    try {
      return await action();
    } catch (error) {
      error.requestTiming = {
        elapsedMs: Date.now() - started,
        queueMs: started - queued,
        timeoutMs: options.timeout,
        // request also honors environment proxies when proxy is unspecified.
        proxy: options.proxy === undefined ? 'environment' : options.proxy ? 'configured' : 'direct'
      };
      throw error;
    }
  });
};
