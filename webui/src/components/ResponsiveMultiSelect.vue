<template>
  <div class="multi-select">
    <button v-if="mobile || visible" ref="trigger" type="button" class="multi-trigger" aria-haspopup="dialog" :aria-expanded="visible" @click="open">
      <span :class="{ 'multi-placeholder': !selected.length }">{{ summary }}</span>
      <span class="multi-count">{{ selected.length ? `已选 ${selected.length} 项` : '选择' }} ›</span>
    </button>
    <a-select v-else mode="multiple" :value="selected" :size="size" :placeholder="placeholder" allow-clear option-filter-prop="label" option-label-prop="label" style="width: 100%;"
      @change="commit" @dropdownVisibleChange="opened => opened && $emit('open')">
      <a-select-option v-for="option in available" :key="option.value" :value="option.value" :label="option.label" :disabled="option.disabled">
        {{ option.label }}{{ option.description ? ' · ' + option.description : '' }}
      </a-select-option>
    </a-select>
    <a-drawer :visible="visible" :title="title || placeholder" placement="bottom" :height="Math.min(680, viewportHeight)" :style="viewportStyle"
      :mask-closable="false" :autofocus="false" :body-style="{ padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }"
      :footer-style="{ padding: '12px 16px max(12px, env(safe-area-inset-bottom))' }" @close="cancel">
      <div class="multi-tools">
        <span role="status">已选 {{ draft.length }} 项</span>
        <a-button type="text" @click="draft = []">清空选择</a-button>
        <a-button @click="toggleSearch">{{ searching ? '收起搜索' : '搜索' }}</a-button>
      </div>
      <div v-if="searching" class="multi-search">
        <a-input ref="search" v-model:value="query" placeholder="搜索名称" allow-clear :maxlength="100" @keydown.enter.prevent />
      </div>
      <div class="multi-options" role="group" :aria-label="title || placeholder">
        <label v-for="option in filtered" :key="option.value" class="multi-option" :class="{ 'multi-disabled': option.disabled }">
          <input type="checkbox" :checked="draft.includes(option.value)" :disabled="option.disabled" @change="toggle(option.value, $event.target.checked)">
          <span><span>{{ option.label }}</span><small v-if="option.description">{{ option.description }}</small></span>
        </label>
        <div v-if="!filtered.length" class="multi-empty">{{ query ? '没有匹配的选项' : '暂无可选项' }}</div>
      </div>
      <template #footer>
        <div class="multi-footer"><a-button @click="cancel">取消</a-button><a-button type="primary" @click="apply">确定（{{ draft.length }}）</a-button></div>
      </template>
    </a-drawer>
  </div>
</template>
<script>
export default {
  props: {
    value: { type: Array, default: () => [] },
    options: { type: Array, default: () => [] },
    placeholder: { type: String, default: '请选择' },
    title: { type: String, default: '' },
    size: { type: String, default: 'middle' }
  },
  emits: ['update:value', 'change', 'open'],
  data () {
    return { mobile: false, visible: false, draft: [], searching: false, query: '', viewportHeight: 600, viewportTop: 0 };
  },
  computed: {
    selected () { return this.value || []; },
    available () {
      const missing = [...new Set([...this.selected, ...this.draft])].filter(value => !this.options.some(option => option.value === value));
      return [...this.options, ...missing.map(value => ({ value, label: String(value), description: '已失效，请移除' }))];
    },
    filtered () {
      const query = this.query.trim().toLocaleLowerCase();
      return this.available.filter(option => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(query));
    },
    summary () {
      const labels = this.selected.slice(0, 2).map(value => this.available.find(option => option.value === value)?.label || value);
      return labels.length ? labels.join('、') + (this.selected.length > 2 ? '…' : '') : this.placeholder;
    },
    viewportStyle () { return this.visible ? { top: this.viewportTop + 'px', height: this.viewportHeight + 'px', bottom: 'auto' } : {}; }
  },
  mounted () {
    this.resize();
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('scroll', this.resize);
  },
  beforeUnmount () {
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('scroll', this.resize);
  },
  methods: {
    resize () {
      this.mobile = window.matchMedia('(max-width: 767px), (pointer: coarse)').matches;
      this.viewportHeight = window.visualViewport?.height || window.innerHeight;
      this.viewportTop = window.visualViewport?.offsetTop || 0;
    },
    open () {
      document.activeElement?.blur();
      this.draft = [...this.selected];
      this.query = '';
      this.searching = false;
      this.resize();
      this.visible = true;
      this.$emit('open');
    },
    toggle (value, checked) { this.draft = checked ? [...new Set([...this.draft, value])] : this.draft.filter(item => item !== value); },
    commit (values) { this.$emit('update:value', values); this.$emit('change', values); },
    apply () {
      const values = [...this.draft];
      this.cancel();
      this.commit(values);
    },
    cancel () {
      this.$refs.search?.blur();
      this.visible = false;
      this.query = '';
      this.searching = false;
      this.$nextTick(() => this.$refs.trigger?.focus({ preventScroll: true }));
    },
    toggleSearch () {
      this.searching = !this.searching;
      if (this.searching) this.$nextTick(() => this.$refs.search?.focus());
      else this.query = '';
    }
  }
};
</script>
<style scoped>
.multi-select { width: 100%; min-width: 0; }
.multi-trigger { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
.multi-trigger > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.multi-count { flex-shrink: 0; font-size: 12px; opacity: .7; }
.multi-placeholder { opacity: .6; }
.multi-tools { display: flex; align-items: center; gap: 8px; padding: 8px 16px; flex-shrink: 0; }
.multi-tools > span { margin-right: auto; }
.multi-tools :deep(.ant-btn), .multi-footer :deep(.ant-btn) { min-height: 44px; }
.multi-search { padding: 0 16px 12px; flex-shrink: 0; }
.multi-search :deep(input) { font-size: 16px; }
.multi-options { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.multi-option { display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-height: 52px; border-top: 1px solid #8883; cursor: pointer; }
.multi-option input { flex-shrink: 0; width: 22px; height: 22px; }
.multi-option > span { min-width: 0; overflow-wrap: anywhere; }
.multi-option small { display: block; opacity: .65; margin-top: 4px; }
.multi-disabled { opacity: .5; cursor: not-allowed; }
.multi-empty { text-align: center; padding: 32px 16px; opacity: .65; }
.multi-footer { display: flex; gap: 12px; }
.multi-footer > * { flex: 1; }
</style>
