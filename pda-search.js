(function(root){
  'use strict';
  const text=value=>String(value??'').normalize('NFC').toLowerCase();

  function initials(name){
    return text(name).normalize('NFKC').replace(/[\s\p{P}]/gu,'')
      .replace(/[\uAC00-\uD7A3]/g,syllable=>
        String.fromCharCode(0x1100+Math.floor((syllable.charCodeAt(0)-0xAC00)/588)));
  }

  function matcher(query){
    const term=text(query).trim();
    const leading=term.normalize('NFKC').replace(/\s/g,'');
    const initialsOnly=/^[\u1100-\u1112]+$/.test(leading);
    return (name,searchText=name)=>!term||text(searchText).includes(term)||
      (initialsOnly&&initials(name).includes(leading));
  }

  root.DBMTPdaSearch={matcher};
})(globalThis);
