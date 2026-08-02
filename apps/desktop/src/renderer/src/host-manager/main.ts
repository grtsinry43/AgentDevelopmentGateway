import { mount } from 'svelte';
import HostManagerApp from './HostManagerApp.svelte';
import '$lib/styles/base.css';

const target = document.getElementById('app');
if (!target) throw new Error('找不到 #app 挂载点');

mount(HostManagerApp, { target });
