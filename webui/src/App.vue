<template>
  <div id="app">
    <div>
      <router-view></router-view>
    </div>
  </div>
</template>

<script>
export default {
  name: 'App',
  components: {
  },
  data () {
    return {
    };
  },
  methods: {
  }
};
</script>
<style lang="less">
@import '../public/assets/styles/light.less';
@import '../public/assets/styles/dark.less' (prefers-color-scheme: dark);

@font-face {
  font-family: 'consolas';
  src: url('../public/assets/fonts/consolas.woff');
}

body {
  font-family: consolas, -apple-system, system-ui, BlinkMacSystemFont, Helvetica, Helvetica Neue, PingFang SC, 'Hiragino Sans GB',
    'Microsoft YaHei', '\u5fae\u8f6f\u96c5\u9ed1', '微软雅黑', Arial, sans-serif;
}

.container-form-mobile {
//  width: min(calc(100vw - 32px), 1440px);
  border-radius: 4px;
  padding: 12px;
  transition: all 0.5s;
}

.container-form-pc {
//  width: min(calc(100vw - 220px), 1440px);
  border-radius: 4px;
  padding: 12px;
  transition: all 0.5s;
}

img[lazy=loading] {
  object-fit: cover;
}

.ant-popover {
  z-index: 1055;
}

// iOS zooms focused form controls with small text. Apply globally so controls
// inside drawers and modals mounted under body receive the same protection.
// Keep pinch zoom available; do not restrict the viewport's maximum scale.
@media (max-width: 767px), (pointer: coarse) {
  body input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='button']):not([type='submit']):not([type='reset']):not([type='hidden']),
  body textarea,
  body select,
  body [contenteditable='true'],
  body .ant-select-selection-search-input {
    font-size: 16px !important;
  }
}

/*
html {
  overflow-y: scroll;
}

:root {
  overflow-y: auto;
  overflow-x: hidden;
}

:root body {
  position: absolute;
}

body {
  width: 100vw;
  overflow: hidden;
}
*/

*::-webkit-scrollbar-thumb {
  border-radius: 10px;
  background-color: #00BFFF;
}

*::-webkit-scrollbar {
  width : 3px;
  height: 3px;
}

*::-webkit-scrollbar-track {
  box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.2);
  background: #ededed;
  border-radius: 10px;
}

</style>
