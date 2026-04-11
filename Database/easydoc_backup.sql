--
-- PostgreSQL database cluster dump
--

\restrict uwHgSWiQ8VfZ31cb2J0FcMA1YwDcMtaeD8D1g59Q2WzokMUhmfEbgCvyhAQc1Kh

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE kevinim;
ALTER ROLE kevinim WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;

--
-- User Configurations
--








\unrestrict uwHgSWiQ8VfZ31cb2J0FcMA1YwDcMtaeD8D1g59Q2WzokMUhmfEbgCvyhAQc1Kh

--
-- Databases
--

--
-- Database "template1" dump
--

\connect template1

--
-- PostgreSQL database dump
--

\restrict RlSbvhEFbUVQkGJaanMjioMhjeDjoUaQbugQYBgoGfr8tZwMNWs5kPRSzGtCvqX

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- PostgreSQL database dump complete
--

\unrestrict RlSbvhEFbUVQkGJaanMjioMhjeDjoUaQbugQYBgoGfr8tZwMNWs5kPRSzGtCvqX

--
-- Database "easydocstation" dump
--

--
-- PostgreSQL database dump
--

\restrict WUOm6ZJgGetqVGt8z9LTAWXho8Vf3O9fI2aMlLfqeYyxejkPlknor98QQ52emjn

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: easydocstation; Type: DATABASE; Schema: -; Owner: kevinim
--

CREATE DATABASE easydocstation WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.UTF-8';


ALTER DATABASE easydocstation OWNER TO kevinim;

\unrestrict WUOm6ZJgGetqVGt8z9LTAWXho8Vf3O9fI2aMlLfqeYyxejkPlknor98QQ52emjn
\connect easydocstation
\restrict WUOm6ZJgGetqVGt8z9LTAWXho8Vf3O9fI2aMlLfqeYyxejkPlknor98QQ52emjn

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: kevinim
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at() OWNER TO kevinim;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: channel_admins; Type: TABLE; Schema: public; Owner: kevinim
--

CREATE TABLE public.channel_admins (
    id integer NOT NULL,
    channel_id character varying(50) NOT NULL,
    user_id integer NOT NULL,
    assigned_by integer,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.channel_admins OWNER TO kevinim;

--
-- Name: channel_admins_id_seq; Type: SEQUENCE; Schema: public; Owner: kevinim
--

CREATE SEQUENCE public.channel_admins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.channel_admins_id_seq OWNER TO kevinim;

--
-- Name: channel_admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kevinim
--

ALTER SEQUENCE public.channel_admins_id_seq OWNED BY public.channel_admins.id;


--
-- Name: channel_members; Type: TABLE; Schema: public; Owner: kevinim
--

CREATE TABLE public.channel_members (
    id integer NOT NULL,
    channel_id character varying(50) NOT NULL,
    user_id integer NOT NULL,
    added_by integer,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.channel_members OWNER TO kevinim;

--
-- Name: channel_members_id_seq; Type: SEQUENCE; Schema: public; Owner: kevinim
--

CREATE SEQUENCE public.channel_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.channel_members_id_seq OWNER TO kevinim;

--
-- Name: channel_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kevinim
--

ALTER SEQUENCE public.channel_members_id_seq OWNED BY public.channel_members.id;


--
-- Name: login_history; Type: TABLE; Schema: public; Owner: kevinim
--

CREATE TABLE public.login_history (
    id integer NOT NULL,
    user_id integer NOT NULL,
    logged_in_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet,
    user_agent text
);


ALTER TABLE public.login_history OWNER TO kevinim;

--
-- Name: login_history_id_seq; Type: SEQUENCE; Schema: public; Owner: kevinim
--

CREATE SEQUENCE public.login_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.login_history_id_seq OWNER TO kevinim;

--
-- Name: login_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kevinim
--

ALTER SEQUENCE public.login_history_id_seq OWNED BY public.login_history.id;


--
-- Name: team_admins; Type: TABLE; Schema: public; Owner: kevinim
--

CREATE TABLE public.team_admins (
    id integer NOT NULL,
    team_id character varying(50) NOT NULL,
    user_id integer NOT NULL,
    assigned_by integer,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.team_admins OWNER TO kevinim;

--
-- Name: team_admins_id_seq; Type: SEQUENCE; Schema: public; Owner: kevinim
--

CREATE SEQUENCE public.team_admins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.team_admins_id_seq OWNER TO kevinim;

--
-- Name: team_admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kevinim
--

ALTER SEQUENCE public.team_admins_id_seq OWNED BY public.team_admins.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: kevinim
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(20) DEFAULT 'user'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['site_admin'::character varying, 'team_admin'::character varying, 'channel_admin'::character varying, 'user'::character varying])::text[])))
);


ALTER TABLE public.users OWNER TO kevinim;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: kevinim
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO kevinim;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: kevinim
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: channel_admins id; Type: DEFAULT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_admins ALTER COLUMN id SET DEFAULT nextval('public.channel_admins_id_seq'::regclass);


--
-- Name: channel_members id; Type: DEFAULT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_members ALTER COLUMN id SET DEFAULT nextval('public.channel_members_id_seq'::regclass);


--
-- Name: login_history id; Type: DEFAULT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.login_history ALTER COLUMN id SET DEFAULT nextval('public.login_history_id_seq'::regclass);


--
-- Name: team_admins id; Type: DEFAULT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.team_admins ALTER COLUMN id SET DEFAULT nextval('public.team_admins_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: channel_admins; Type: TABLE DATA; Schema: public; Owner: kevinim
--

COPY public.channel_admins (id, channel_id, user_id, assigned_by, assigned_at) FROM stdin;
\.


--
-- Data for Name: channel_members; Type: TABLE DATA; Schema: public; Owner: kevinim
--

COPY public.channel_members (id, channel_id, user_id, added_by, added_at) FROM stdin;
2	ch-3	8	1	2026-04-11 18:47:37.280695+09
3	ch-3	5	1	2026-04-11 18:47:47.083283+09
5	ch-1	5	1	2026-04-11 18:52:10.247718+09
\.


--
-- Data for Name: login_history; Type: TABLE DATA; Schema: public; Owner: kevinim
--

COPY public.login_history (id, user_id, logged_in_at, ip_address, user_agent) FROM stdin;
1	1	2026-04-11 17:32:54.586949+09	::ffff:127.0.0.1	curl/8.7.1
2	1	2026-04-11 17:40:44.311685+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
3	5	2026-04-11 17:47:11.853207+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
4	7	2026-04-11 18:15:05.860606+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
5	7	2026-04-11 18:16:39.92896+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
6	1	2026-04-11 18:17:01.272486+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
7	1	2026-04-11 18:18:07.307456+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
8	1	2026-04-11 18:26:20.644418+09	::1	Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36
\.


--
-- Data for Name: team_admins; Type: TABLE DATA; Schema: public; Owner: kevinim
--

COPY public.team_admins (id, team_id, user_id, assigned_by, assigned_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: kevinim
--

COPY public.users (id, username, password_hash, name, email, role, is_active, created_at, updated_at, last_login_at) FROM stdin;
5	freegear	$2a$10$0pSKyJbzRzhzHkthECPic.oIOp2isTv8unAqjrlQSWzZSMwH0tG1C	임종윤	freegear.next@gmail.com	site_admin	t	2026-04-11 17:41:56.327912+09	2026-04-11 17:47:11.847711+09	2026-04-11 17:47:11.847711+09
7	테스트#1	$2a$10$CxUl8dETlTTgiTiOiipDEO6KGcrdSkG0r21ifXxDqKxuCeS57VPfm	테스트#1	freegear.nex1t@gmail.com	user	t	2026-04-11 17:48:14.22348+09	2026-04-11 18:16:39.924976+09	2026-04-11 18:16:39.924976+09
8	12333	$2a$10$eYeTOiaht2U8jl/laqRvz.I/v5T5JXeBBBPsm6BRevBTZkA5qXKmC	33333	freegear.nex3@gmail.com	channel_admin	t	2026-04-11 18:17:37.479232+09	2026-04-11 18:17:37.479232+09	\N
1	kevin	$2a$10$36yQySJDYmeN22g3Cc89guhbWdBUbjSb3tvqwOmcYmQK4vYorivvy	Kevin Im	kevin@easydocstation.com	site_admin	t	2026-04-11 17:26:05.236234+09	2026-04-11 18:59:03.007035+09	2026-04-11 18:26:20.627666+09
\.


--
-- Name: channel_admins_id_seq; Type: SEQUENCE SET; Schema: public; Owner: kevinim
--

SELECT pg_catalog.setval('public.channel_admins_id_seq', 1, false);


--
-- Name: channel_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: kevinim
--

SELECT pg_catalog.setval('public.channel_members_id_seq', 5, true);


--
-- Name: login_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: kevinim
--

SELECT pg_catalog.setval('public.login_history_id_seq', 8, true);


--
-- Name: team_admins_id_seq; Type: SEQUENCE SET; Schema: public; Owner: kevinim
--

SELECT pg_catalog.setval('public.team_admins_id_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: kevinim
--

SELECT pg_catalog.setval('public.users_id_seq', 8, true);


--
-- Name: channel_admins channel_admins_channel_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_admins
    ADD CONSTRAINT channel_admins_channel_id_user_id_key UNIQUE (channel_id, user_id);


--
-- Name: channel_admins channel_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_admins
    ADD CONSTRAINT channel_admins_pkey PRIMARY KEY (id);


--
-- Name: channel_members channel_members_channel_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_channel_id_user_id_key UNIQUE (channel_id, user_id);


--
-- Name: channel_members channel_members_pkey; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_pkey PRIMARY KEY (id);


--
-- Name: login_history login_history_pkey; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT login_history_pkey PRIMARY KEY (id);


--
-- Name: team_admins team_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.team_admins
    ADD CONSTRAINT team_admins_pkey PRIMARY KEY (id);


--
-- Name: team_admins team_admins_team_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.team_admins
    ADD CONSTRAINT team_admins_team_id_user_id_key UNIQUE (team_id, user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_channel_admins_ch; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_channel_admins_ch ON public.channel_admins USING btree (channel_id);


--
-- Name: idx_channel_members_ch; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_channel_members_ch ON public.channel_members USING btree (channel_id);


--
-- Name: idx_login_history_user; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_login_history_user ON public.login_history USING btree (user_id);


--
-- Name: idx_team_admins_team; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_team_admins_team ON public.team_admins USING btree (team_id);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_role; Type: INDEX; Schema: public; Owner: kevinim
--

CREATE INDEX idx_users_role ON public.users USING btree (role);


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: kevinim
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: channel_admins channel_admins_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_admins
    ADD CONSTRAINT channel_admins_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channel_admins channel_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_admins
    ADD CONSTRAINT channel_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_members channel_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channel_members channel_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.channel_members
    ADD CONSTRAINT channel_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: login_history login_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.login_history
    ADD CONSTRAINT login_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_admins team_admins_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.team_admins
    ADD CONSTRAINT team_admins_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: team_admins team_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: kevinim
--

ALTER TABLE ONLY public.team_admins
    ADD CONSTRAINT team_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict WUOm6ZJgGetqVGt8z9LTAWXho8Vf3O9fI2aMlLfqeYyxejkPlknor98QQ52emjn

--
-- Database "postgres" dump
--

\connect postgres

--
-- PostgreSQL database dump
--

\restrict vfM8NejcojGSnWJ0rVwCkWOckXu5xamMs51bahGbUc8v7Bk39QFSq9e1VpGMBXo

-- Dumped from database version 16.13 (Homebrew)
-- Dumped by pg_dump version 16.13 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- PostgreSQL database dump complete
--

\unrestrict vfM8NejcojGSnWJ0rVwCkWOckXu5xamMs51bahGbUc8v7Bk39QFSq9e1VpGMBXo

--
-- PostgreSQL database cluster dump complete
--

