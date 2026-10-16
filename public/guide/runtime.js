

    function GetQueryString(name){
        var reg = new RegExp("(^|&)"+ name +"=([^&]*)(&|$)");
        var r = window.location.search.substr(1).match(reg);
        if(r!=null)return  unescape(r[2]); return null;
    }
    console.log(GetQueryString("type"))
    console.log(GetQueryString("bIsWM"))
    var type = GetQueryString("type") || 2
    var bIsWM = GetQueryString("bIsWM") || ""
    // 腾讯会议
    var button = document.getElementById("button");
    var pcbutton = document.getElementById("pcbutton");
    var content_html = document.getElementById("content_html");
    var content_pc = document.getElementById("content_pc");
    //魔典
    var mdbutton = document.getElementById("mdbutton");
    var content_pc_md = document.getElementById("content_pc_md");
    
    // type:1为腾讯会议  2为魔典
    if(type == 1 && bIsWM == 'android' || type == 1 && bIsWM == 'ios'){
        button.style.display = "block"
        content_html.style.zIndex = '99'
        content_pc.style.zIndex = '1'
    } else if(type == 1 && bIsWM == 'windows' || type == 1 && bIsWM == 'macOS'){
        button.style.display = "none"
        pcbutton.style.display = "block"
        content_html.style.zIndex = '1'
        content_pc.style.zIndex = '99'
    } else if(type == 2){
        button.style.display = "none"
        pcbutton.style.display = "none"
        content_html.style.zIndex = '1'
        content_pc.style.zIndex = '1'
        mdbutton.style.display = "block"
        content_pc_md.style.zIndex = '99'
    }



    // 腾讯H5
    function change_pic(){
        var button1 = document.getElementById("button1");
        var button2 = document.getElementById("button2");
        var picts = document.getElementById("picts");
        button1.onclick = function(){
            console.log("button1")
            picts.setAttribute("src","/guide/images/stroller_h5.png");
        }
        button2.onclick = function(){
            console.log("button2")
            picts.setAttribute("src","/guide/images/player_h5.png");
        }
    }
    change_pic();
    // 腾讯pc
    function change_pic_pc(){
        var pcbutton1 = document.getElementById("pcbutton1");
        var pcbutton2 = document.getElementById("pcbutton2");
        var pc_picts = document.getElementById("pc_picts");
        pcbutton1.onclick = function(){
            pc_picts.setAttribute("src","/guide/images/stroller_pc.png");
        }
        pcbutton2.onclick = function(){
            pc_picts.setAttribute("src","/guide/images/player_pc.png");
        }
    }
    change_pic_pc()

    // 魔典
    function change_pic_md(){
        var mdbutton1 = document.getElementById("mdbutton1");
        var mdbutton2 = document.getElementById("mdbutton2");
        var md_picts = document.getElementById("md_picts");
        mdbutton1.onclick = function(){
            md_picts.setAttribute("src","/guide/images/stroller_md.png");
        }
        mdbutton2.onclick = function(){
            md_picts.setAttribute("src","/guide/images/player_md.png");
        }
    }
    change_pic_md()
