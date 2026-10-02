// Подключается в <head> до стилей и тела страницы: класс темы ставится на
// <html> до первой отрисовки, поэтому при запуске не мелькает светлая тема.
// Без явного выбора пользователя используется системная тема.
(function () {
  function savedTheme() {
    try {
      const value = localStorage.getItem('theme');
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  window.__theme = {
    saved: savedTheme,
    isDark: () => {
      const saved = savedTheme();
      return saved ? saved === 'dark' : systemPrefersDark();
    }
  };

  document.documentElement.classList.toggle('dark-theme', window.__theme.isDark());
})();
