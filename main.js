// TechnoFormer v2 — shared JS
(function(){
  // Mobile menu toggle
  var btn = document.getElementById('navToggle');
  var menu = document.getElementById('mobileMenu');
  if(btn && menu){
    btn.addEventListener('click', function(){ menu.classList.toggle('open'); });
    menu.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){ menu.classList.remove('open'); });
    });
  }
  // Scroll reveal
  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, {threshold:.12});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
  // Footer year
  var y = document.getElementById('year');
  if(y){ y.textContent = new Date().getFullYear(); }
  // Page search filter
  var searchInput = document.getElementById('pageSearch');
  if(searchInput){
    searchInput.addEventListener('input', function(){
      var q = this.value.toLowerCase().trim();
      // Find all searchable cards on this page
      var cards = document.querySelectorAll('.video-shell, article.card');
      var visible = 0;
      cards.forEach(function(card){
        var text = card.textContent.toLowerCase();
        if(!q || text.indexOf(q) !== -1){
          card.style.display = '';
          visible++;
        } else {
          card.style.display = 'none';
        }
      });
      // Show "no results" message
      var noRes = document.getElementById('noResults');
      if(!noRes && q){
        noRes = document.createElement('p');
        noRes.id = 'noResults';
        noRes.style.cssText = 'text-align:center;color:var(--muted);padding:40px;font-size:18px';
        noRes.textContent = '😅 Kuch nahi mila — kuch aur try karein!';
        var grid = document.querySelector('.grid');
        if(grid) grid.parentNode.insertBefore(noRes, grid.nextSibling);
      }
      if(noRes){ noRes.style.display = visible === 0 && q ? '' : 'none'; }
    });
  }
})();
