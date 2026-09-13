const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => entry.target.classList.toggle('visible', entry.isIntersecting));
}, { threshold: 0.15 });
document.querySelectorAll('.steps article, .hardware-copy, .pilot-card').forEach((el) => observer.observe(el));
