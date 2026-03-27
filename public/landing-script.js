// ===== MOBILE MENU =====
const menuToggle = document.getElementById('menuToggle');
const nav = document.getElementById('nav');

menuToggle.addEventListener('click', () => {
  nav.classList.toggle('open');
});

// Close menu when a link is clicked
nav.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => nav.classList.remove('open'));
});

// ===== HEADER SCROLL EFFECT =====
const header = document.getElementById('header');
window.addEventListener('scroll', () => {
  if (window.scrollY > 20) {
    header.style.background = 'rgba(13,27,42,.97)';
  } else {
    header.style.background = 'rgba(13,27,42,.92)';
  }
});

// ===== CONTACT FORM =====
const form = document.getElementById('contactForm');
const submitBtn = document.getElementById('submitBtn');
const formSuccess = document.getElementById('formSuccess');
const emailInput = document.getElementById('email');
const replyto = document.getElementById('replyto');

emailInput.addEventListener('input', () => {
  replyto.value = emailInput.value;
});

form.addEventListener('submit', async (e) => {
  const action = form.getAttribute('action');

  // If Formspree endpoint is not configured, use mailto fallback
  if (!action || action.includes('SEU_ENDPOINT_AQUI')) {
    e.preventDefault();
    const name    = document.getElementById('name').value;
    const email   = document.getElementById('email').value;
    const phone   = document.getElementById('phone').value;
    const subject = document.getElementById('subject').value;
    const message = document.getElementById('message').value;

    const body = encodeURIComponent(
      `Nome: ${name}\nE-mail: ${email}\nTelefone: ${phone}\n\nServiço: ${subject}\n\nMensagem:\n${message}`
    );
    const mailtoLink = `mailto:daniel.marsh@marshconsultoria.com.br?subject=Contato%20via%20site%20-%20${encodeURIComponent(subject)}&body=${body}`;
    window.location.href = mailtoLink;

    formSuccess.style.display = 'block';
    formSuccess.textContent = 'Seu cliente de e-mail foi aberto! Clique em Enviar para concluir.';
    return;
  }

  // Formspree submission
  e.preventDefault();
  submitBtn.textContent = 'Enviando...';
  submitBtn.disabled = true;

  try {
    const data = new FormData(form);
    const response = await fetch(form.action, {
      method: 'POST',
      body: data,
      headers: { Accept: 'application/json' }
    });

    if (response.ok) {
      form.reset();
      formSuccess.style.display = 'block';
      formSuccess.textContent = 'Mensagem enviada com sucesso! Em breve entraremos em contato.';
      submitBtn.textContent = 'Enviado!';
    } else {
      throw new Error('Erro no envio');
    }
  } catch {
    submitBtn.textContent = 'Enviar Mensagem';
    submitBtn.disabled = false;
    alert('Ocorreu um erro. Por favor, entre em contato diretamente pelo e-mail ou WhatsApp.');
  }
});

// ===== SCROLL ANIMATIONS =====
const observerOptions = { threshold: 0.12, rootMargin: '0px 0px -40px 0px' };

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, observerOptions);

document.querySelectorAll('.card, .why-item, .info-item, .avatar-card, .about-text').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(28px)';
  el.style.transition = 'opacity .5s ease, transform .5s ease';
  observer.observe(el);
});
