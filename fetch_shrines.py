from streamlit_js_eval import get_geolocation
import pandas as pd
from geopy.distance import geodesic

st.title("⛩️ リアルタイムGPS御朱印帳")

# --- GPS取得セクション ---
st.subheader("現在地の取得")
loc = get_geolocation()

if loc:
    curr_lat = loc['coords']['latitude']
    curr_lon = loc['coords']['longitude']
    st.success(f"現在地を確認しました: (緯度: {curr_lat:.4f}, 経度: {curr_lon:.4f})")
    
    # --- 神社判定ロジック ---
    shrines_df = pd.read_csv('shrines_data.csv')
    found = False
    
    for index, row in shrines_df.iterrows():
        shrine_loc = (row['lat'], row['lon'])
        user_loc = (curr_lat, curr_lon)
        dist = geodesic(shrine_loc, user_loc).meters # メートル単位
        
        # 100メートル以内に近づいたらチェックイン可能
        if dist < 100:
            st.info(f"✨ {row['name']} の境内にいます (距離: {dist:.1f}m)")
            if st.button(f"{row['name']} のデジタル御朱印を授かる"):
                st.balloons()
                st.image("https://via.placeholder.com/300x450?text=Premium+Goshuin", caption="参拝証明")
            found = True
            break
            
    if not found:
        st.warning("近くに登録された神社が見つかりません。もう少し近づいてみてください。")
else:
    st.info("ブラウザの現在地許可をオンにして「現在地を取得」を確認してください。")

# --- (以下、履歴表示などは共通) ---

