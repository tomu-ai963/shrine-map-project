import streamlit as st
from streamlit_js_eval import get_geolocation
import pandas as pd
from geopy.distance import geodesic
import sqlite3

# 1. データベース初期化（履歴保存用）
def init_db():
    conn = sqlite3.connect('my_goshuin.db')
    c = conn.cursor()
    c.execute('CREATE TABLE IF NOT EXISTS logs (name TEXT, date TEXT)')
    conn.commit()
    return conn

st.set_page_config(page_title="デジタル御朱印帳", page_icon="⛩️")
st.title("⛩️ デジタル御朱印帳")

# 2. GPS取得
loc = get_geolocation()

if loc:
    curr_lat = loc['coords']['latitude']
    curr_lon = loc['coords']['longitude']
    
    # 3. 神社データの読み込み
    try:
        shrines_df = pd.read_csv('shrines_data.csv')
        found = False
        
        for _, row in shrines_df.iterrows():
            dist = geodesic((row['lat'], row['lon']), (curr_lat, curr_lon)).meters
            
            if dist < 100:  # 100m以内
                st.success(f"📍 {row['name']} に到着しました！")
                if st.button(f"{row['name']} の御朱印を授かる"):
                    # DBに保存
                    conn = init_db()
                    conn.execute("INSERT INTO logs VALUES (?, date('now'))", (row['name'],))
                    conn.commit()
                    st.balloons()
                    st.image("https://via.placeholder.com/300x400?text=Goshuin", caption=f"{row['name']} 参拝記念")
                found = True
                break
        
        if not found:
            st.warning("近くに神社が見つかりません。")
            
    except FileNotFoundError:
        st.error("先に 'fetch_shrines.py' を実行して、神社リスト(csv)を作成してください。")

# 4. 履歴表示
st.divider()
st.subheader("📜 これまでの参拝履歴")
conn = init_db()
logs_df = pd.read_sql_query("SELECT * FROM logs", conn)
st.dataframe(logs_df, use_container_width=True)
